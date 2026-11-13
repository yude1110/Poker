'use strict';

const { randomInt } = require('node:crypto');
const { evaluate, describeHand, RANKS } = require('./evaluator');

const SUITS = 'shdc';
const NEXT_STAGE = { preflop: 'flop', flop: 'turn', turn: 'river' };
const CARDS_TO_DEAL = { flop: 3, turn: 1, river: 1 };

/** 玩家操作不合法時丟出，訊息會直接顯示給玩家。 */
class GameError extends Error {}

function shuffledDeck(rng) {
  const deck = [];
  for (const rank of RANKS) for (const suit of SUITS) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 單桌德州撲克規則引擎。不碰網路與計時器：
 * 呼叫 act() / advance() 推進牌局，外層決定節奏。
 */
class Game {
  constructor({ smallBlind, bigBlind, maxPlayers = 9, rng = randomInt }) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.maxPlayers = maxPlayers;
    this.rng = rng;
    this.seats = new Array(maxPlayers).fill(null);
    this.hand = null;
    this.handNo = 0;
    this.dealerSeat = null;
    this.events = [];
  }

  get players() {
    return this.seats.filter(Boolean);
  }

  get live() {
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  addPlayer({ id, name, stack }) {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new GameError('這桌已經坐滿了');
    const player = {
      id, name, seat, stack,
      sittingOut: false, leaving: false,
      inHand: false, cards: [], bet: 0, committed: 0,
      folded: false, allIn: false, hasActed: false, actedAtLevel: 0,
      lastAction: null, shown: false,
    };
    this.seats[seat] = player;
    return player;
  }

  /** 牌局中離開會先棄牌，等這手結束才真正讓出座位。 */
  removePlayer(id) {
    const player = this.getPlayer(id);
    if (!player) return;
    if (this.hand && player.inHand) {
      player.leaving = true;
      this._forceFold(player);
    } else {
      this.seats[player.seat] = null;
    }
  }

  eligiblePlayers() {
    return this.players.filter((p) => p.stack > 0 && !p.sittingOut && !p.leaving);
  }

  canStartHand() {
    return !this.hand && this.eligiblePlayers().length >= 2;
  }

  startHand() {
    if (this.hand) throw new GameError('這手牌還沒結束');
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) throw new GameError('至少需要兩位玩家');

    for (const p of this.players) {
      Object.assign(p, {
        inHand: false, cards: [], bet: 0, committed: 0, folded: false, allIn: false,
        hasActed: false, actedAtLevel: 0, lastAction: null, shown: false,
      });
    }
    for (const p of eligible) p.inHand = true;

    const dealer = this.dealerSeat === null
      ? eligible[this.rng(eligible.length)]
      : this._nextInHandFrom(this.dealerSeat);
    this.dealerSeat = dealer.seat;
    const order = this._clockwiseFrom(dealer.seat);

    // 單挑時莊家是小盲，翻牌前先行動
    const headsUp = order.length === 2;
    const sb = headsUp ? dealer : order[0];
    const bb = headsUp ? order[0] : order[1];

    this.handNo += 1;
    this.hand = {
      no: this.handNo,
      deck: shuffledDeck(this.rng),
      community: [],
      stage: 'preflop',
      sbSeat: sb.seat,
      bbSeat: bb.seat,
      toAct: null,
      turnId: 0,
      currentBet: this.bigBlind,
      minRaise: this.bigBlind,
      pendingAdvance: false,
      revealAllIn: false,
      results: null,
    };

    for (let i = 0; i < 2; i++) for (const p of order) p.cards.push(this.hand.deck.pop());

    this.events.push({ t: 'hand_start', no: this.handNo, dealerSeat: dealer.seat });
    this._postBlind(sb, this.smallBlind, 'sb');
    this._postBlind(bb, this.bigBlind, 'bb');
    this._continueFrom(bb.seat);
  }

  _postBlind(player, amount, kind) {
    this._commit(player, amount);
    this.events.push({ t: 'blind', id: player.id, name: player.name, kind, amount: player.bet });
  }

  _commit(player, amount) {
    const paid = Math.min(amount, player.stack);
    player.stack -= paid;
    player.bet += paid;
    player.committed += paid;
    if (player.stack === 0) player.allIn = true;
  }

  /** 從指定座位的下一位開始，順時針列出本手牌還在局內的玩家（含已棄牌）。 */
  _clockwiseFrom(seat) {
    const result = [];
    for (let i = 1; i <= this.maxPlayers; i++) {
      const p = this.seats[(seat + i) % this.maxPlayers];
      if (p && p.inHand) result.push(p);
    }
    return result;
  }

  _nextInHandFrom(seat) {
    return this._clockwiseFrom(seat)[0];
  }

  _othersCanAct(player) {
    return this.live.some((p) => p !== player && !p.allIn);
  }

  /**
   * 這位玩家要跟到多少。短碼大盲全下時，後面玩家仍要跟滿一個大盲；
   * 但如果其他人全都全下了，就只需要跟到他們實際下注的最大值。
   */
  _callTarget(player) {
    if (this._othersCanAct(player)) return this.hand.currentBet;
    const highest = Math.max(0, ...this.live.filter((p) => p !== player).map((p) => p.bet));
    return Math.min(this.hand.currentBet, highest);
  }

  _needsAction(player) {
    if (!player.inHand || player.folded || player.allIn) return false;
    if (player.bet < this._callTarget(player)) return true;
    return !player.hasActed && this._othersCanAct(player);
  }

  /** 從 fromSeat 的下一位起找到該行動的人；沒有人要行動就結束這輪下注。 */
  _continueFrom(fromSeat) {
    const hand = this.hand;
    const next = this._clockwiseFrom(fromSeat).find((p) => this._needsAction(p));
    if (next) {
      if (hand.toAct !== next.seat) {
        hand.toAct = next.seat;
        hand.turnId += 1;
      }
      return;
    }
    this._closeRound();
  }

  _closeRound() {
    const hand = this.hand;
    hand.toAct = null;
    hand.pendingAdvance = true;
    this._refundUncalled();
    if (this.live.filter((p) => !p.allIn).length <= 1) hand.revealAllIn = true;
  }

  /** 沒有人跟到的多餘下注退回。 */
  _refundUncalled() {
    const ordered = this.players.filter((p) => p.inHand).sort((a, b) => b.committed - a.committed);
    const [top, second] = ordered;
    if (!second || top.folded || top.committed === second.committed) return;
    const refund = top.committed - second.committed;
    top.committed -= refund;
    top.bet -= refund;
    top.stack += refund;
    top.allIn = false; // 拿回籌碼就不算全下了
    if (top.lastAction === 'allin') top.lastAction = 'raise';
    this.events.push({ t: 'refund', id: top.id, name: top.name, amount: refund });
  }

  legalActions(id) {
    const hand = this.hand;
    const player = this.getPlayer(id);
    if (!hand || !player || hand.toAct !== player.seat) return null;
    const toCall = Math.max(0, this._callTarget(player) - player.bet);
    const maxRaiseTo = player.bet + player.stack;
    // 不足額的全下加注不會重新打開已行動玩家的加注權
    const reopened = !player.hasActed || hand.currentBet - player.actedAtLevel >= hand.minRaise;
    const canRaise = this._othersCanAct(player) && player.stack > toCall && reopened;
    return {
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, player.stack),
      canRaise,
      minRaiseTo: canRaise ? Math.min(hand.currentBet + hand.minRaise, maxRaiseTo) : 0,
      maxRaiseTo: canRaise ? maxRaiseTo : 0,
    };
  }

  act(id, action, amount) {
    const hand = this.hand;
    const legal = this.legalActions(id);
    if (!legal) throw new GameError('現在還沒輪到你');
    const player = this.getPlayer(id);
    const event = { t: 'action', id, name: player.name, action };

    switch (action) {
      case 'fold':
        player.folded = true;
        break;
      case 'check':
        if (!legal.canCheck) throw new GameError('現在不能過牌');
        break;
      case 'call':
        if (legal.canCheck) throw new GameError('沒有下注可以跟');
        this._commit(player, legal.callAmount);
        event.amount = legal.callAmount;
        break;
      case 'raise': {
        if (!legal.canRaise) throw new GameError('現在不能加注');
        if (!Number.isSafeInteger(amount) || amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
          throw new GameError(`加注金額需介於 ${legal.minRaiseTo} 到 ${legal.maxRaiseTo}`);
        }
        event.action = hand.currentBet === 0 ? 'bet' : 'raise';
        const increment = amount - hand.currentBet;
        if (increment >= hand.minRaise) hand.minRaise = increment;
        // minRaiseTo 被籌碼上限截斷時，加注額可能不高於目前注額
        hand.currentBet = Math.max(hand.currentBet, amount);
        this._commit(player, amount - player.bet);
        event.amount = amount;
        break;
      }
      default:
        throw new GameError('未知的操作');
    }

    event.allIn = player.allIn;
    player.hasActed = true;
    player.actedAtLevel = hand.currentBet;
    player.lastAction = player.allIn ? 'allin' : event.action;
    this.events.push(event);

    if (this.live.length === 1) this._finishUncontested();
    else this._continueFrom(player.seat);
  }

  _forceFold(player) {
    const hand = this.hand;
    if (hand.stage === 'showdown' || player.folded) return;
    player.folded = true;
    player.lastAction = 'fold';
    this.events.push({ t: 'action', id: player.id, name: player.name, action: 'fold' });
    if (this.live.length === 1) {
      this._finishUncontested();
    } else if (!hand.pendingAdvance) {
      // 其他人該不該行動可能因此改變；從目前行動者重新判斷
      this._continueFrom((hand.toAct - 1 + this.maxPlayers) % this.maxPlayers);
    }
  }

  /** 結束本輪下注後由外層呼叫：發下一條街，或進入攤牌。 */
  advance() {
    const hand = this.hand;
    if (!hand || !hand.pendingAdvance) return;
    hand.pendingAdvance = false;
    this._clearRoundBets();

    if (hand.stage === 'river') {
      this._showdown();
      return;
    }

    hand.stage = NEXT_STAGE[hand.stage];
    hand.deck.pop(); // 燒牌
    const cards = [];
    for (let i = 0; i < CARDS_TO_DEAL[hand.stage]; i++) cards.push(hand.deck.pop());
    hand.community.push(...cards);
    this.events.push({ t: 'street', stage: hand.stage, cards });

    if (this.live.filter((p) => !p.allIn).length >= 2) this._continueFrom(this.dealerSeat);
    else this._closeRound();
  }

  _clearRoundBets() {
    const hand = this.hand;
    hand.currentBet = 0;
    hand.minRaise = this.bigBlind;
    for (const p of this.players) {
      p.bet = 0;
      p.hasActed = false;
      p.actedAtLevel = 0;
      if (p.lastAction !== 'fold' && p.lastAction !== 'allin') p.lastAction = null;
    }
  }

  /** 依每位玩家投入的籌碼切出主池與邊池。 */
  _buildPots(contributionOf) {
    const inHand = this.players.filter((p) => p.inHand);
    const contributions = inHand.map((p) => ({ player: p, amount: contributionOf(p) }));
    const levels = [...new Set(contributions.filter((c) => !c.player.folded && c.amount > 0).map((c) => c.amount))]
      .sort((a, b) => a - b);

    const pots = [];
    let previous = 0;
    for (const level of levels) {
      let amount = 0;
      for (const c of contributions) amount += Math.min(c.amount, level) - Math.min(c.amount, previous);
      const eligible = contributions.filter((c) => !c.player.folded && c.amount >= level).map((c) => c.player);
      pots.push({ amount, eligible });
      previous = level;
    }

    // 已棄牌玩家投入得比所有留局玩家都多時，多的部分併入最後一個池
    const total = contributions.reduce((sum, c) => sum + c.amount, 0);
    const assigned = pots.reduce((sum, pot) => sum + pot.amount, 0);
    if (total > assigned && pots.length) pots[pots.length - 1].amount += total - assigned;
    return pots;
  }

  _showdown() {
    const hand = this.hand;
    hand.stage = 'showdown';
    hand.toAct = null;

    const evaluated = new Map(this.live.map((p) => [p.id, evaluate([...p.cards, ...hand.community])]));
    const payouts = {};
    const pots = [];
    const clockwise = this._clockwiseFrom(this.dealerSeat);

    for (const pot of this._buildPots((p) => p.committed)) {
      const bestScore = Math.max(...pot.eligible.map((p) => evaluated.get(p.id).score));
      const winners = clockwise.filter((p) => pot.eligible.includes(p) && evaluated.get(p.id).score === bestScore);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount % winners.length; // 零頭從莊家左手邊開始給
      const potResult = { amount: pot.amount, winners: [] };
      for (const winner of winners) {
        const won = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        winner.stack += won;
        payouts[winner.id] = (payouts[winner.id] || 0) + won;
        const hv = evaluated.get(winner.id);
        potResult.winners.push({ id: winner.id, name: winner.name, amount: won, handName: hv.name, cards: hv.cards });
      }
      pots.push(potResult);
    }

    const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
    const handNames = Object.fromEntries([...evaluated].map(([id, hv]) => [id, hv.name]));
    hand.results = { uncontested: false, total, pots, payouts, handNames };
    this._settle();
  }

  _finishUncontested() {
    const hand = this.hand;
    const [winner] = this.live;
    this._refundUncalled();
    const total = this.players.reduce((sum, p) => sum + p.committed, 0);
    winner.stack += total;
    hand.stage = 'showdown';
    hand.toAct = null;
    hand.pendingAdvance = false;
    hand.results = {
      uncontested: true,
      total,
      pots: [{ amount: total, winners: [{ id: winner.id, name: winner.name, amount: total, handName: null, cards: [] }] }],
      payouts: { [winner.id]: total },
      handNames: {},
    };
    this._settle();
  }

  _settle() {
    for (const p of this.players) {
      p.committed = 0;
      p.bet = 0;
    }
    this.events.push({ t: 'results', results: this.hand.results });
  }

  /** 攤牌階段主動亮牌（例如別人都棄牌後想秀一下）。 */
  show(id) {
    const player = this.getPlayer(id);
    if (!this.hand || this.hand.stage !== 'showdown' || !player || !player.inHand || !player.cards.length) {
      throw new GameError('現在不能亮牌');
    }
    player.shown = true;
  }

  /** 結束這手牌，清掉要離開的玩家，讓下一手可以開始。 */
  endHand() {
    this.hand = null;
    for (const p of this.players) {
      Object.assign(p, {
        inHand: false, cards: [], bet: 0, committed: 0, folded: false, allIn: false,
        hasActed: false, actedAtLevel: 0, lastAction: null, shown: false,
      });
      if (p.leaving) this.seats[p.seat] = null;
    }
  }

  _cardsVisibleTo(player, viewerId) {
    const hand = this.hand;
    if (!hand || !player.inHand) return false;
    if (player.id === viewerId || player.shown) return true;
    if (player.folded) return false;
    if (hand.revealAllIn) return true;
    return hand.stage === 'showdown' && !hand.results.uncontested;
  }

  /** 針對單一玩家產生狀態；其他人的底牌在該公開前一律不送出。 */
  viewFor(viewerId) {
    const hand = this.hand;
    const viewer = this.getPlayer(viewerId);
    const potOnTable = this.players.reduce((sum, p) => sum + p.committed - p.bet, 0);
    const betsTotal = this.players.reduce((sum, p) => sum + p.bet, 0);
    const sidePots = hand && !hand.results
      ? this._buildPots((p) => p.committed - p.bet).map((pot) => pot.amount)
      : [];

    let yourHandName = null;
    if (hand && viewer && viewer.inHand && !viewer.folded) {
      yourHandName = describeHand([...viewer.cards, ...hand.community]);
    }

    return {
      handNo: this.handNo,
      stage: hand ? hand.stage : 'waiting',
      community: hand ? hand.community : [],
      dealerSeat: this.dealerSeat,
      sbSeat: hand ? hand.sbSeat : null,
      bbSeat: hand ? hand.bbSeat : null,
      toActSeat: hand ? hand.toAct : null,
      turnId: hand ? `${hand.no}:${hand.turnId}` : null,
      currentBet: hand ? hand.currentBet : 0,
      potOnTable,
      betsTotal,
      sidePots,
      results: hand ? hand.results : null,
      legal: this.legalActions(viewerId),
      yourHandName,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        stack: p.stack,
        bet: p.bet,
        inHand: p.inHand,
        folded: p.folded,
        allIn: p.allIn,
        sittingOut: p.sittingOut,
        lastAction: p.lastAction,
        shown: p.shown,
        cards: p.inHand ? p.cards.map((c) => (this._cardsVisibleTo(p, viewerId) ? c : null)) : [],
      })),
    };
  }
}

module.exports = { Game, GameError };
