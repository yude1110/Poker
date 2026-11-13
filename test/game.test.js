'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError } = require('../server/game');

/** rng 固定回 0，所以第一手的莊家一定是 p0。 */
function makeGame(stacks, { sb = 5, bb = 10, maxPlayers = 9 } = {}) {
  const game = new Game({ smallBlind: sb, bigBlind: bb, maxPlayers, rng: () => 0 });
  stacks.forEach((stack, i) => game.addPlayer({ id: `p${i}`, name: `P${i}`, stack }));
  return game;
}

const toActId = (game) => game.seats[game.hand.toAct].id;
const totalChips = (game) => game.players.reduce((sum, p) => sum + p.stack + p.committed, 0);

/** 把剩下的街全部發完（所有人過牌）。 */
function runOut(game) {
  while (game.hand.stage !== 'showdown') {
    if (game.hand.pendingAdvance) game.advance();
    else game.act(toActId(game), 'check');
  }
}

/** 指定底牌與公共牌，讓攤牌結果可預期。 */
function rigDeck(game, holes, board) {
  const hand = game.hand;
  for (const [id, cards] of Object.entries(holes)) game.getPlayer(id).cards = cards;
  // 牌堆是從尾巴 pop：每條街先燒一張
  hand.deck = [board[4], 'xx', board[3], 'xx', board[2], board[1], board[0], 'xx'];
}

test('三人以上：莊家左手是小盲、下一位大盲、再下一位先行動', () => {
  const game = makeGame([100, 100, 100, 100]);
  game.startHand();
  const hand = game.hand;
  assert.equal(game.dealerSeat, 0);
  assert.equal(hand.sbSeat, 1);
  assert.equal(hand.bbSeat, 2);
  assert.equal(hand.toAct, 3);
  assert.equal(game.getPlayer('p1').bet, 5);
  assert.equal(game.getPlayer('p2').bet, 10);
});

test('單挑：莊家是小盲且翻牌前先行動，翻牌後後行動', () => {
  const game = makeGame([100, 100]);
  game.startHand();
  const hand = game.hand;
  assert.equal(hand.sbSeat, game.dealerSeat);
  assert.equal(hand.toAct, game.dealerSeat);
  game.act(toActId(game), 'call');
  // 大盲還有選擇權
  assert.equal(hand.toAct, hand.bbSeat);
  game.act(toActId(game), 'check');
  game.advance();
  assert.equal(hand.stage, 'flop');
  assert.equal(hand.toAct, hand.bbSeat);
});

test('大盲選擇權：全員跟注後大盲仍可加注', () => {
  const game = makeGame([100, 100, 100]);
  game.startHand();
  game.act('p0', 'call');
  game.act('p1', 'call');
  assert.equal(toActId(game), 'p2');
  const legal = game.legalActions('p2');
  assert.equal(legal.canCheck, true);
  assert.equal(legal.canRaise, true);
  assert.equal(legal.minRaiseTo, 20);
});

test('最小加注額跟著上一次完整加注變動', () => {
  const game = makeGame([1000, 1000, 1000]);
  game.startHand();
  game.act('p0', 'raise', 40); // 加了 30
  assert.equal(game.legalActions('p1').minRaiseTo, 70);
  assert.throws(() => game.act('p1', 'raise', 60), GameError);
  game.act('p1', 'raise', 100); // 加了 60
  assert.equal(game.legalActions('p2').minRaiseTo, 160);
});

test('不能亂行動：沒輪到、不能過牌、金額不合法都會被擋', () => {
  const game = makeGame([100, 100, 100]);
  game.startHand();
  assert.throws(() => game.act('p1', 'call'), GameError);
  assert.throws(() => game.act('p0', 'check'), GameError);
  assert.throws(() => game.act('p0', 'raise', 15), GameError);
  assert.throws(() => game.act('p0', 'raise', 1000), GameError);
  assert.throws(() => game.act('p0', 'raise', 25.5), GameError);
  assert.throws(() => game.act('p0', 'raise', '50'), GameError);
  assert.throws(() => game.act('p0', 'steal'), GameError);
});

test('不足額全下不會重開已行動玩家的加注權', () => {
  const game = makeGame([1000, 1000, 130, 1000]);
  game.startHand();
  // p3 先行動：加注到 100（加了 90）
  game.act('p3', 'raise', 100);
  game.act('p0', 'call');
  game.act('p1', 'fold');
  // p2 全下 130，只多 30，不足完整加注
  game.act('p2', 'raise', 130);
  assert.equal(game.getPlayer('p2').allIn, true);
  // p3 已行動過，只能跟或棄
  const legal = game.legalActions('p3');
  assert.equal(legal.callAmount, 30);
  assert.equal(legal.canRaise, false);
  assert.throws(() => game.act('p3', 'raise', 300), GameError);
});

test('多次不足額全下累積達完整加注時，加注權重新打開', () => {
  const game = makeGame([1000, 130, 195, 1000]);
  game.startHand();
  game.act('p3', 'raise', 100); // 加了 90
  game.act('p0', 'call');
  game.act('p1', 'raise', 130); // 只多 30
  game.act('p2', 'raise', 195); // 再多 65，累積 95 >= 90
  assert.equal(game.legalActions('p3').canRaise, true);
  assert.equal(game.legalActions('p3').minRaiseTo, 285);
});

test('沒行動過的玩家面對不足額全下仍可加注', () => {
  const game = makeGame([1000, 1000, 1000, 1000, 125]);
  game.startHand();
  game.act('p3', 'raise', 100);
  game.act('p4', 'raise', 125); // 不足額全下
  const legal = game.legalActions('p0');
  assert.equal(legal.canRaise, true);
  assert.equal(legal.minRaiseTo, 215); // 125 + 上次完整加注 90
});

test('多餘下注退回：對手短碼全下時多下的拿回來', () => {
  const game = makeGame([1000, 200]);
  game.startHand();
  // 單挑：莊家（p0，rng 回 0）是小盲
  game.act('p0', 'raise', 500);
  game.act('p1', 'call'); // 全下 200
  const p0 = game.getPlayer('p0');
  assert.equal(p0.committed, 200);
  assert.equal(p0.stack, 800);
  assert.equal(game.hand.revealAllIn, true);
});

test('全下被退回多餘籌碼後，不再標示為全下', () => {
  const game = makeGame([1000, 200]);
  game.startHand();
  game.act('p0', 'raise', 1000);
  game.act('p1', 'call');
  const p0 = game.getPlayer('p0');
  assert.equal(p0.stack, 800);
  assert.equal(p0.allIn, false);
  assert.equal(p0.lastAction, 'raise');
});

test('短碼大盲全下：小盲只需要跟到實際金額', () => {
  const game = makeGame([1000, 8]);
  game.startHand();
  // p0 是莊家/小盲 5，p1 大盲全下 8
  assert.equal(game.legalActions('p0').callAmount, 3);
  assert.equal(game.legalActions('p0').canRaise, false);
});

test('短碼小盲全下：大盲不用行動，多的退回', () => {
  const game = makeGame([3, 1000]);
  game.startHand();
  // p0 是莊家/小盲只有 3
  assert.equal(game.hand.toAct, null);
  assert.equal(game.hand.pendingAdvance, true);
  assert.equal(game.getPlayer('p1').committed, 3);
  while (game.hand.stage !== 'showdown') game.advance();
  assert.equal(game.getPlayer('p0').stack + game.getPlayer('p1').stack, 1003);
});

test('三人多層邊池：短碼只贏得到自己有參與的池', () => {
  const game = makeGame([100, 300, 500]);
  game.startHand();
  // p0 莊家先行動
  game.act('p0', 'raise', 100); // 全下 100
  game.act('p1', 'raise', 300); // 全下 300
  game.act('p2', 'call'); // 跟 300
  // p0 最強、p1 次之、p2 最弱
  rigDeck(game, { p0: ['As', 'Ad'], p1: ['Ks', 'Kd'], p2: ['2c', '7d'] }, ['Qh', 'Jd', '9c', '4s', '3h']);
  while (game.hand.stage !== 'showdown') game.advance();
  const { results } = game.hand;
  assert.deepEqual(results.pots.map((pot) => pot.amount), [300, 400]);
  assert.equal(results.pots[0].winners[0].id, 'p0');
  assert.equal(results.pots[1].winners[0].id, 'p1');
  assert.equal(game.getPlayer('p0').stack, 300);
  assert.equal(game.getPlayer('p1').stack, 400);
  assert.equal(game.getPlayer('p2').stack, 200);
});

test('棄牌玩家的籌碼留在池內但不能分池', () => {
  const game = makeGame([1000, 1000, 1000]);
  game.startHand();
  game.act('p0', 'raise', 100);
  game.act('p1', 'call');
  game.act('p2', 'call');
  game.advance();
  game.act('p1', 'raise', 200);
  game.act('p2', 'fold');
  game.act('p0', 'call');
  rigDeck(game, { p0: ['As', 'Ad'], p1: ['Ks', 'Kd'], p2: ['Qc', 'Qd'] }, ['Jh', '9d', '4c', '2h', '3h']);
  game.hand.community = ['Jh', '9d', '4c'];
  runOut(game);
  // 底池 = 翻牌前 100 x 3 + 翻牌圈 200 x 2
  assert.equal(game.hand.results.total, 700);
  assert.equal(game.getPlayer('p0').stack, 1000 - 300 + 700);
  assert.equal(game.getPlayer('p2').stack, 900);
});

test('平分底池：零頭給莊家左手邊第一位贏家', () => {
  const game = makeGame([1000, 1000, 1000]);
  game.startHand();
  game.act('p0', 'fold');
  game.act('p1', 'raise', 25); // p1 小盲加到 25
  game.act('p2', 'call');
  // 小盲 25 + 大盲 25 = 50，加入棄牌的奇數籌碼來測零頭
  game.getPlayer('p0').committed = 1;
  game.getPlayer('p0').stack -= 1;
  rigDeck(game, { p1: ['2c', '3d'], p2: ['2d', '3c'] }, ['As', 'Ks', 'Qs', 'Js', 'Ts']);
  while (game.hand.stage !== 'showdown') {
    if (game.hand.pendingAdvance) game.advance();
    else game.act(toActId(game), 'check');
  }
  const { payouts } = game.hand.results;
  assert.equal(payouts.p1, 26);
  assert.equal(payouts.p2, 25);
});

test('所有人棄牌：最後一人直接贏，不公開底牌', () => {
  const game = makeGame([100, 100, 100]);
  game.startHand();
  game.act('p0', 'fold');
  game.act('p1', 'fold');
  assert.equal(game.hand.stage, 'showdown');
  assert.equal(game.hand.results.uncontested, true);
  assert.equal(game.getPlayer('p2').stack, 105);
  const view = game.viewFor('p0');
  assert.deepEqual(view.players.find((p) => p.id === 'p2').cards, [null, null]);
});

test('底牌隱私：只看得到自己的牌，攤牌才公開未棄牌者', () => {
  const game = makeGame([100, 100, 100]);
  game.startHand();
  const view = game.viewFor('p0');
  assert.equal(view.players[0].cards.every(Boolean), true);
  assert.deepEqual(view.players[1].cards, [null, null]);
  assert.deepEqual(view.players[2].cards, [null, null]);
  const serialized = JSON.stringify(view);
  for (const id of ['p1', 'p2']) {
    for (const card of game.getPlayer(id).cards) assert.equal(serialized.includes(`"${card}"`), false);
  }

  game.act('p0', 'fold');
  game.act('p1', 'call');
  game.act('p2', 'check');
  runOut(game);
  const final = game.viewFor('p1');
  assert.deepEqual(final.players[0].cards, [null, null]); // 棄牌者不公開
  assert.equal(final.players[2].cards.every(Boolean), true);
});

test('全下跑牌時提前公開雙方底牌', () => {
  const game = makeGame([100, 100]);
  game.startHand();
  game.act('p0', 'raise', 100);
  game.act('p1', 'call');
  const view = game.viewFor('p0');
  assert.equal(view.players[1].cards.every(Boolean), true);
});

test('中途離開：輪到時等同棄牌，局外離開立刻讓座', () => {
  const game = makeGame([100, 100, 100, 100]);
  game.startHand();
  assert.equal(toActId(game), 'p3');
  game.removePlayer('p3');
  assert.equal(game.getPlayer('p3').folded, true);
  assert.equal(toActId(game), 'p0');
  // 沒輪到的人離開，輪到的人不變
  game.removePlayer('p1');
  assert.equal(toActId(game), 'p0');
  game.act('p0', 'fold');
  assert.equal(game.hand.results.uncontested, true);
  game.endHand();
  assert.equal(game.getPlayer('p3'), null);
  assert.equal(game.getPlayer('p1'), null);
});

test('莊家位每手順時針移動並跳過破產與離座玩家', () => {
  const game = makeGame([100, 0, 100, 100]);
  game.startHand();
  assert.equal(game.dealerSeat, 0);
  game.act(toActId(game), 'fold');
  game.act(toActId(game), 'fold');
  game.endHand();
  game.getPlayer('p2').sittingOut = true;
  game.startHand();
  assert.equal(game.dealerSeat, 3);
  assert.equal(game.getPlayer('p2').inHand, false);
});

test('隨機模擬：數千手牌籌碼守恆、輪序合法、牌不重複', () => {
  let seed = 123456789;
  const random = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor((seed / 4294967296) * n);
  };

  let hands = 0;
  let sidePotHands = 0;
  for (let round = 0; round < 600; round++) {
    const count = 2 + random(8);
    const game = new Game({ smallBlind: 5, bigBlind: 10, maxPlayers: 9, rng: random });
    for (let i = 0; i < count; i++) {
      game.addPlayer({ id: `p${i}`, name: `P${i}`, stack: 1 + random(500) });
    }
    const initial = game.players.reduce((sum, p) => sum + p.stack, 0);

    for (let handIndex = 0; handIndex < 30 && game.canStartHand(); handIndex++) {
      game.startHand();
      hands += 1;
      const all = [...game.players.flatMap((p) => p.cards), ...game.hand.deck];
      assert.equal(new Set(all).size, all.length);

      let guard = 0;
      while (game.hand.stage !== 'showdown') {
        assert.ok(++guard < 500, '牌局沒有結束');
        assert.equal(totalChips(game), initial);
        if (game.hand.pendingAdvance) {
          game.advance();
          continue;
        }
        const id = toActId(game);
        const legal = game.legalActions(id);
        const roll = random(100);
        if (legal.canRaise && roll < 30) {
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          game.act(id, 'raise', legal.minRaiseTo + random(span + 1));
        } else if (roll < 45 && !legal.canCheck) {
          game.act(id, 'fold');
        } else if (legal.canCheck) {
          game.act(id, 'check');
        } else {
          game.act(id, 'call');
        }
      }

      const { results } = game.hand;
      if (results.pots.length > 1) sidePotHands += 1;
      assert.equal(game.players.reduce((sum, p) => sum + p.stack, 0), initial);
      assert.ok(game.players.every((p) => p.stack >= 0 && Number.isInteger(p.stack)));
      assert.equal(results.pots.reduce((sum, pot) => sum + pot.amount, 0), results.total);
      if (!results.uncontested) assert.equal(game.hand.community.length, 5);
      game.endHand();
    }
  }
  assert.ok(hands > 5000, `只模擬了 ${hands} 手`);
  assert.ok(sidePotHands > 100, `邊池情境太少：${sidePotHands}`);
});
