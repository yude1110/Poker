import { $, el, fmt, clamp, lerp, setText, hueOf } from './util.js';
import { createCard, revealCard } from './cards.js';
import { flyChips, dealFrom, pop, tweenNumber, setNumber } from './fx.js';
import { sound } from './sound.js';

const ACTION_LABELS = { fold: '棄牌', check: '過牌', call: '跟注', raise: '加注', bet: '下注', allin: '全下' };
const STAGE_LABELS = { flop: '翻牌', turn: '轉牌', river: '河牌' };
const SUIT_GLYPHS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const CENTER_X = 50;
const CENTER_Y = 46;
const URGENT_MS = 5000;

// 直向螢幕太窄，橢圓排法會蓋到公共牌與自己的手牌：
// 其他座位固定排在兩側與頂端（自己之後順時針），中間留給牌。
const HERO_PORTRAIT = [50, 90];
const PORTRAIT_SEATS = {
  2: [[50, 10]],
  3: [[14, 28], [86, 28]],
  4: [[14, 62], [50, 10], [86, 62]],
  5: [[14, 62], [14, 28], [86, 28], [86, 62]],
  6: [[14, 62], [14, 28], [50, 10], [86, 28], [86, 62]],
  7: [[14, 62], [14, 28], [32, 10], [68, 10], [86, 28], [86, 62]],
  8: [[14, 80], [14, 62], [14, 28], [50, 10], [86, 28], [86, 62], [86, 80]],
  9: [[14, 80], [14, 62], [14, 28], [32, 10], [68, 10], [86, 28], [86, 62], [86, 80]],
};

const cardText = (code) => `${code[0] === 'T' ? '10' : code[0]}${SUIT_GLYPHS[code[1]]}`;

/** 牌桌畫面：只更新有變動的節點，動畫才不會被重新渲染打斷。 */
export class TableView {
  constructor({ onTurnStart }) {
    this.onTurnStart = onTurnStart;
    this.stage = $('stage');
    this.seatsRoot = $('seats');
    this.boardRoot = $('board');
    this.potNode = $('pot-amount');
    this.seatViews = [];
    this.layoutKey = '';
    this.s = null;
    this.boardCards = [];
    this.turnAnim = null;
    this.turnKey = null;
    this.turnIdSeen = null;
    this.urgentTimers = [];
    this.resultsShownFor = null;
    this.portrait = false;
    new ResizeObserver(() => this._layout(true)).observe(this.stage);
  }

  /** 重新進入房間時清空所有視覺狀態。 */
  reset() {
    this.s = null;
    this.layoutKey = '';
    this.boardCards = [];
    this.turnKey = null;
    this.turnIdSeen = null;
    this.resultsShownFor = null;
    this.seatViews = [];
    this.seatsRoot.replaceChildren();
    this._clearBoard();
    this._stopTurnTimers();
  }

  update(state, events) {
    const prev = this.s;
    this.s = state;
    this.hero = state.players.find((p) => p.id === state.you) || null;
    this._layout(false);

    const newHand = Boolean(prev) && state.handNo !== prev.handNo && state.stage !== 'waiting';
    const instant = !prev;
    const gathered = this._gatherBets(prev, state);

    if (newHand) this._prepareNewHand();
    this._renderSeats(prev, state, { newHand, instant });
    this._renderBoard(state, { instant, delay: gathered ? 320 : 0 });
    this._renderPot(state, instant);
    this._renderTurn(state, instant);
    this._renderResults(state, instant);
    this._renderWaiting(state);
    this._renderDealer(state);
    this._playEventSounds(events, state, instant);
  }

  showBubble(id, text) {
    const player = this.s?.players.find((p) => p.id === id);
    if (!player) return;
    const view = this.seatViews[player.seat];
    view.root.querySelector('.bubble')?.remove();
    const bubble = el('div', 'bubble', text);
    bubble.addEventListener('animationend', () => bubble.remove());
    view.root.append(bubble);
  }

  /* ---------- 版面 ---------- */

  _layout(force) {
    const state = this.s;
    if (!state) return;
    const rect = this.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const portrait = rect.height > rect.width * 1.05;
    const n = state.settings.maxPlayers;
    const heroSeat = this.hero ? this.hero.seat : 0;
    const key = `${n}:${heroSeat}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
    if (!force && key === this.layoutKey) return;
    this.layoutKey = key;

    if (portrait !== this.portrait) {
      this.portrait = portrait;
      document.body.classList.toggle('portrait', portrait);
    }
    const scale = portrait
      ? clamp(Math.min(rect.width / 410, rect.height / 640), 0.68, 1.15)
      : clamp(Math.min(rect.width / 1000, rect.height / 560), 0.5, 1.35);
    document.documentElement.style.setProperty('--s', scale.toFixed(3));

    this._ensureSeats(n);
    const halfW = (portrait ? 54 : 76) * scale;
    const halfH = (portrait ? 24 : 28) * scale;
    const cardsAbove = (portrait ? 34 : 50) * scale;

    for (let seat = 0; seat < n; seat++) {
      const relative = (seat - heroSeat + n) % n;
      const angle = Math.PI / 2 + (relative * 2 * Math.PI) / n;
      let [x, y] = portrait
        ? (relative === 0 ? HERO_PORTRAIT : PORTRAIT_SEATS[n][relative - 1])
        : [CENTER_X + 42 * Math.cos(angle), CENTER_Y + 39 * Math.sin(angle)];
      // 不讓座位或牌超出舞台
      x = clamp(x, ((halfW + 4) / rect.width) * 100, 100 - ((halfW + 4) / rect.width) * 100);
      y = clamp(y, ((halfH + cardsAbove) / rect.height) * 100, 100 - ((halfH + 20 * scale) / rect.height) * 100);

      const view = this.seatViews[seat];
      view.x = x;
      view.y = y;
      view.relative = relative;
      view.root.style.left = `${x}%`;
      view.root.style.top = `${y}%`;
      view.root.classList.toggle('is-hero', relative === 0);

      if (relative === 0 && portrait) {
        // 直向時兩側有鄰座，自己的注碼放在大牌正上方
        view.bet.style.left = `${x}%`;
        view.bet.style.top = `${y - (136 * scale / rect.height) * 100}%`;
      } else if (relative === 0) {
        // 橫向時放在大牌旁邊，避免被手牌蓋住
        view.bet.style.left = `${x + (132 * scale / rect.width) * 100}%`;
        view.bet.style.top = `${y - (56 * scale / rect.height) * 100}%`;
      } else {
        // 注碼往牌桌中央靠，下半部的座位要避開自己上方的手牌
        const tx = portrait ? 0.5 : 0.4;
        const ty = portrait ? (y < CENTER_Y ? 0.42 : 0.35) : (y < CENTER_Y ? 0.52 : 0.48);
        view.bet.style.left = `${lerp(x, CENTER_X, tx)}%`;
        view.bet.style.top = `${lerp(y, CENTER_Y, ty)}%`;
      }
    }
    this._renderDealer(state);
  }

  _ensureSeats(n) {
    if (this.seatViews.length === n) return;
    this.seatsRoot.replaceChildren();
    this.seatViews = [];
    for (let seat = 0; seat < n; seat++) {
      const root = el('div', 'seat empty');
      const holes = el('div', 'holes');
      const plate = el('div', 'plate');
      const avatar = el('div', 'avatar');
      const meta = el('div', 'meta');
      const name = el('div', 'name');
      const stack = el('div', 'stack');
      const timer = el('div', 'timer');
      const bar = el('i');
      timer.append(bar);
      meta.append(name, stack);
      plate.append(avatar, meta, timer);
      const tag = el('div', 'tag');
      root.append(holes, plate, tag);
      const bet = el('div', 'bet is-empty');
      const betAmount = el('span');
      bet.append(el('i', 'chip'), betAmount);
      this.seatsRoot.append(root, bet);
      this.seatViews.push({
        root, holes, plate, avatar, name, stack, bar, tag, bet, betAmount,
        cards: [], playerId: null, betValue: 0, x: 50, y: 50, relative: 0,
      });
    }
  }

  /* ---------- 座位 ---------- */

  _renderSeats(prev, state, { newHand, instant }) {
    const bySeat = new Map(state.players.map((p) => [p.seat, p]));
    const order = this._dealOrder(state);

    this.seatViews.forEach((view, seat) => {
      const player = bySeat.get(seat);
      view.root.classList.toggle('empty', !player);
      if (!player) {
        this._clearSeat(view);
        return;
      }
      if (view.playerId !== player.id) {
        view.playerId = player.id;
        setText(view.avatar, [...player.name][0].toUpperCase());
        view.root.style.setProperty('--hue', hueOf(player.name));
        setNumber(view.stack, player.stack, fmt);
      }
      const isHost = player.id === state.hostId;
      setText(view.name, player.name + (isHost ? ' ★' : ''));

      const results = state.results;
      const payout = results?.payouts[player.id] || 0;
      const justSettled = results && !prev?.results;
      tweenNumber(view.stack, player.stack, fmt, justSettled && payout ? { delay: 650, duration: 600 } : {});

      view.root.classList.toggle('is-turn', state.toActSeat === seat);
      view.root.classList.toggle('is-winner', payout > 0);
      view.root.classList.toggle('is-folded', player.inHand && player.folded);
      view.root.classList.toggle('is-out', player.sittingOut || !player.connected);

      this._renderTag(view, player, state);
      this._renderHoles(view, player, state, { newHand, instant, order });
      this._renderBet(view, player, prev, instant);
    });
  }

  _clearSeat(view) {
    if (view.playerId === null) return;
    view.playerId = null;
    view.holes.replaceChildren();
    view.cards = [];
    view.bet.classList.add('is-empty');
    view.betValue = 0;
    setText(view.tag, '');
  }

  _renderTag(view, player, state) {
    let text = '';
    let kind = '';
    const handName = state.results?.handNames[player.id];
    if (handName) {
      text = handName;
      kind = 'hand';
    } else if (!player.connected) {
      text = '斷線中';
      kind = 'off';
    } else if (player.sittingOut && !player.inHand) {
      text = '離座';
      kind = 'off';
    } else if (player.stack === 0 && !player.inHand) {
      text = '籌碼用完';
      kind = 'off';
    } else if (player.lastAction) {
      text = ACTION_LABELS[player.lastAction];
      kind = player.lastAction;
    }
    if (view.tag.dataset.kind !== kind) view.tag.dataset.kind = kind;
    setText(view.tag, text);
  }

  /** 從莊家左手邊開始的發牌順序，用來排動畫延遲。 */
  _dealOrder(state) {
    const inHand = state.players.filter((p) => p.inHand);
    const n = state.settings.maxPlayers;
    const distance = (p) => (p.seat - state.dealerSeat - 1 + n * 2) % n;
    return new Map(inHand.sort((a, b) => distance(a) - distance(b)).map((p, i) => [p.id, i]));
  }

  _renderHoles(view, player, state, { newHand, instant, order }) {
    if (newHand || !player.cards.length) {
      if (view.cards.length) {
        view.holes.replaceChildren();
        view.cards = [];
      }
    }
    view.holes.classList.toggle('is-folded', player.folded);
    if (!player.cards.length) return;

    const players = order.size;
    player.cards.forEach((code, i) => {
      let card = view.cards[i];
      if (!card) {
        card = createCard(code, { faceUp: instant });
        view.holes.append(card);
        view.cards[i] = card;
        if (!instant) {
          const position = order.get(player.id) ?? 0;
          const delay = (position + i * players) * 90;
          dealFrom(card, this.boardRoot, { delay });
          sound.deal(delay / 1000);
          // 看得到的牌（自己的、全下公開的）發到後才翻開
          if (code) setTimeout(() => card.classList.add('is-up'), delay + 340);
        }
      } else if (code && !card.classList.contains('is-up')) {
        // 動畫中的手牌由上面的計時器翻開；這裡處理攤牌與重連
        const pending = card.dataset.card === code;
        if (!pending) {
          revealCard(card, code);
          sound.flip();
        }
      }
    });
  }

  _renderBet(view, player, prev, instant) {
    const amount = player.bet;
    if (amount === view.betValue) return;
    const rose = amount > view.betValue;
    view.betValue = amount;
    view.bet.classList.toggle('is-empty', amount === 0);
    if (amount > 0) setText(view.betAmount, fmt(amount));
    if (rose && !instant && prev) {
      flyChips(view.plate, view.bet, { count: 3, duration: 340, stagger: 40 });
      pop(view.bet);
    }
  }

  /** 一輪下注結束：注碼飛向底池。要在座位更新前先量好位置。 */
  _gatherBets(prev, state) {
    if (!prev) return false;
    let moved = false;
    for (const view of this.seatViews) {
      if (!view.betValue) continue;
      const player = state.players.find((p) => p.id === view.playerId);
      if (player && player.bet === 0) {
        flyChips(view.bet, $('pot'), { count: 4, duration: 420, stagger: 35 });
        moved = true;
      }
    }
    if (moved) sound.chip();
    return moved;
  }

  /* ---------- 公共牌與底池 ---------- */

  _clearBoard() {
    this.boardCards = [];
    if (!this.boardRoot.children.length) {
      for (let i = 0; i < 5; i++) this.boardRoot.append(el('div', 'slot'));
    }
    for (const slot of this.boardRoot.children) slot.replaceChildren();
    this.boardRoot.classList.remove('has-win');
    $('banner').hidden = true;
  }

  _prepareNewHand() {
    this._clearBoard();
    this.resultsShownFor = null;
    for (const view of this.seatViews) {
      view.betValue = 0;
      view.bet.classList.add('is-empty');
      view.plate.classList.remove('is-dim');
    }
  }

  _renderBoard(state, { instant, delay }) {
    if (!this.boardRoot.children.length) this._clearBoard();
    if (state.stage === 'waiting' && this.boardCards.length) this._clearBoard();
    const fresh = state.community.slice(this.boardCards.length);
    if (!fresh.length) return;
    fresh.forEach((code, i) => {
      const slot = this.boardRoot.children[this.boardCards.length];
      const card = createCard(code, { faceUp: instant });
      slot.append(card);
      this.boardCards.push(card);
      if (instant) return;
      const at = delay + i * 130;
      dealFrom(card, this.boardRoot, { delay: at, duration: 340 });
      setTimeout(() => card.classList.add('is-up'), at + 170);
      sound.flip((at + 170) / 1000);
    });
  }

  _renderPot(state, instant) {
    // 底池含桌上還沒收進來的注碼，也就是贏家這手實際能拿到的總額
    const total = state.results ? state.results.total : state.potOnTable + state.betsTotal;
    const showPot = state.stage !== 'waiting';
    $('pot').hidden = !showPot;
    if (!showPot) return;
    if (instant) setNumber(this.potNode, total, fmt);
    else tweenNumber(this.potNode, total, fmt);

    const sides = state.sidePots.length > 1 ? state.sidePots : [];
    const key = sides.join(',');
    const root = $('side-pots');
    if (root.dataset.key !== key) {
      root.dataset.key = key;
      root.replaceChildren(...sides.map((amount, i) => el('span', '', `${i === 0 ? '主池' : `邊池${i}`} ${fmt(amount)}`)));
    }
  }

  /* ---------- 計時 ---------- */

  _stopTurnTimers() {
    this.turnAnim?.cancel();
    this.turnAnim = null;
    this.urgentTimers.forEach(clearTimeout);
    this.urgentTimers = [];
  }

  _renderTurn(state, instant) {
    const isMine = this.hero && state.toActSeat === this.hero.seat;
    $('stage').classList.toggle('my-turn', Boolean(isMine));

    // 同一回合的計時可能被縮短（玩家斷線），要重新對齊倒數條
    const key = state.toActSeat === null ? null : `${state.turnId}:${state.turnTimerId}`;
    if (key === this.turnKey) return;
    const isNewTurn = state.turnId !== this.turnIdSeen;
    this.turnIdSeen = state.turnId;
    this.turnKey = key;
    this._stopTurnTimers();
    if (key === null) return;

    const remaining = state.turnRemainingMs;
    const total = state.turnTotalMs || remaining;
    const view = this.seatViews[state.toActSeat];
    this.turnAnim = view.bar.animate(
      [{ transform: `scaleX(${clamp(remaining / total, 0, 1)})` }, { transform: 'scaleX(0)' }],
      { duration: remaining, easing: 'linear', fill: 'both' },
    );

    if (isMine) {
      if (!instant && isNewTurn) sound.turn();
      if (isNewTurn) this.onTurnStart?.();
      for (let left = URGENT_MS; left > 0; left -= 1000) {
        if (remaining > left) this.urgentTimers.push(setTimeout(() => sound.tick(), remaining - left));
      }
    }
  }

  /* ---------- 結算 ---------- */

  _renderResults(state, instant) {
    const results = state.results;
    const banner = $('banner');
    if (!results) {
      if (state.stage === 'waiting') banner.hidden = true;
      return;
    }
    const key = state.handNo;
    if (this.resultsShownFor === key) {
      this._highlightWinningCards(state);
      return;
    }
    this.resultsShownFor = key;

    const delay = instant ? 0 : 480;
    setTimeout(() => {
      if (this.resultsShownFor !== key) return;
      for (const [id, amount] of Object.entries(results.payouts)) {
        const player = state.players.find((p) => p.id === id);
        if (!player || amount <= 0) continue;
        if (!instant) flyChips($('pot'), this.seatViews[player.seat].plate, { count: 8, duration: 620, stagger: 45 });
      }
      this._renderBanner(results);
      this._highlightWinningCards(state);
      if (!instant && results.payouts[state.you]) sound.win();
    }, delay);
  }

  _renderBanner(results) {
    const banner = $('banner');
    const multi = results.pots.length > 1;
    const lines = [];
    results.pots.forEach((pot, i) => {
      for (const winner of pot.winners) {
        const line = el('div', 'line');
        if (multi) line.append(el('small', '', i === 0 ? '主池' : `邊池${i}`));
        line.append(el('span', '', winner.name), el('b', '', `+${fmt(winner.amount)}`));
        if (winner.handName) line.append(el('em', '', winner.handName));
        lines.push(line);
      }
    });
    banner.replaceChildren(...lines);
    banner.hidden = false;
  }

  _highlightWinningCards(state) {
    const winning = new Set(state.results.pots[0].winners.flatMap((w) => w.cards));
    if (!winning.size) return;
    const all = [...this.boardCards, ...this.seatViews.flatMap((view) => view.cards)];
    for (const card of all) {
      const isWin = winning.has(card.dataset.card);
      card.classList.toggle('is-win', isWin);
      card.classList.toggle('is-dim', !isWin && card.dataset.card !== undefined);
    }
  }

  /* ---------- 其他 ---------- */

  _renderWaiting(state) {
    const waiting = $('waiting');
    const show = state.stage === 'waiting';
    waiting.hidden = !show;
    $('center').hidden = show;
    if (!show) return;
    const isHost = state.hostId === state.you;
    const seated = state.players.length;
    const ready = state.players.filter((p) => p.stack > 0 && !p.sittingOut && p.connected).length;
    setText($('waiting-code'), state.code);
    $('btn-start').hidden = !isHost || state.started;
    $('btn-start').disabled = ready < 2;
    let text;
    if (state.started) text = ready >= 2 ? '下一手即將開始…' : '等待至少兩位有籌碼的玩家回到牌桌';
    else if (ready < 2) text = `已入座 ${seated} / ${state.settings.maxPlayers}，把連結傳給朋友一起玩`;
    else if (isHost) text = `已入座 ${seated} 位，準備好就開始吧`;
    else text = `已入座 ${seated} 位，等待房主開始`;
    setText($('waiting-text'), text);
  }

  _renderDealer(state) {
    const dealer = $('dealer');
    if (state.dealerSeat === null || state.stage === 'waiting' || !this.seatViews[state.dealerSeat]) {
      dealer.hidden = true;
      return;
    }
    const view = this.seatViews[state.dealerSeat];
    const rect = this.stage.getBoundingClientRect();
    const offset = view.plate.offsetWidth / 2 + dealer.offsetWidth / 2 + 6;
    // 放在座位板靠牌桌中央的那一側；自己的座位右邊是注碼，所以放左邊
    const side = view.relative === 0 || view.x > CENTER_X ? -1 : 1;
    dealer.style.left = `${view.x + (side * offset / rect.width) * 100}%`;
    dealer.style.top = `${view.y}%`;
    dealer.hidden = false;
  }

  _playEventSounds(events, state, instant) {
    if (instant) return;
    for (const event of events) {
      if (event.t !== 'action') continue;
      if (event.allIn) sound.allIn();
      else if (event.action === 'fold') sound.fold();
      else if (event.action === 'check') sound.check();
      else sound.chip();
    }
  }
}

/** 紀錄面板的文字。 */
export function describeEvent(event) {
  switch (event.t) {
    case 'hand_start':
      return { cls: 'f-hand', text: `── 第 ${event.no} 手 ──` };
    case 'blind':
      return { text: `${event.name} 下${event.kind === 'sb' ? '小' : '大'}盲 ${fmt(event.amount)}` };
    case 'action': {
      const label = ACTION_LABELS[event.action];
      let text = `${event.name} ${label}`;
      if (event.action === 'raise') text = `${event.name} 加注到 ${fmt(event.amount)}`;
      else if (event.amount) text += ` ${fmt(event.amount)}`;
      if (event.allIn) text += '（全下）';
      return { text };
    }
    case 'street':
      return { cls: 'f-street', text: `${STAGE_LABELS[event.stage]}　${event.cards.map(cardText).join(' ')}` };
    case 'refund':
      return { text: `${fmt(event.amount)} 未被跟注，退回給 ${event.name}` };
    case 'results':
      return event.results.pots.flatMap((pot) => pot.winners.map((winner) => ({
        cls: 'f-win',
        text: `${winner.name} 贏得 ${fmt(winner.amount)}${winner.handName ? `（${winner.handName}）` : ''}`,
      })));
    case 'info': {
      const texts = {
        join: `${event.name} 加入牌桌`,
        leave: `${event.name} 離開牌桌`,
        disconnect: `${event.name} 斷線了`,
        reconnect: `${event.name} 回來了`,
        host: `${event.name} 成為房主`,
        rebuy: `${event.name} 重新買入 ${fmt(event.amount ?? 0)}`,
        timeout: `${event.name} 超時`,
      };
      return { text: texts[event.kind] };
    }
    default:
      return null;
  }
}
