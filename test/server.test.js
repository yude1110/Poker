'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGameServer } = require('../server');

/** 測試用 WebSocket 客戶端：記錄最新狀態，可以等待特定訊息。 */
class Client {
  constructor(port) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.messages = [];
    this.waiters = [];
    this.state = null;
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'state') this.state = message.state;
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => !waiter(message));
    });
    this.opened = new Promise((resolve) => this.socket.addEventListener('open', resolve));
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', resolve));
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** 等到 predicate 成立；先檢查已收到的最新狀態。 */
  waitFor(predicate, label = 'message', timeout = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待逾時：${label}`)), timeout);
      const check = (message) => {
        if (!predicate(message)) return false;
        clearTimeout(timer);
        resolve(message);
        return true;
      };
      for (const message of this.messages) if (check(message)) return;
      this.waiters.push(check);
    });
  }

  /** 只看從現在開始的新訊息。 */
  next(predicate, label) {
    this.messages = [];
    return this.waitFor(predicate, label);
  }
}

async function withServer(fn, options = {}) {
  const game = createGameServer({ port: 0, host: '127.0.0.1', paceScale: 0.02, ...options });
  const port = await game.listen();
  const clients = [];
  const connect = async () => {
    const client = new Client(port);
    clients.push(client);
    await client.opened;
    return client;
  };
  try {
    await fn({ connect, port, game });
  } finally {
    for (const client of clients) client.socket.close();
    await game.close();
  }
}

async function openRoom(connect, names, settings = {}) {
  const host = await connect();
  host.send({ t: 'create', name: names[0], settings: { smallBlind: 5, bigBlind: 10, startingStack: 1000, maxPlayers: 6, ...settings } });
  const joined = await host.waitFor((m) => m.t === 'joined', 'joined');
  const others = [];
  for (const name of names.slice(1)) {
    const client = await connect();
    client.send({ t: 'join', code: joined.code, name });
    await client.waitFor((m) => m.t === 'joined', 'joined');
    others.push(client);
  }
  return { code: joined.code, clients: [host, ...others], token: joined.token };
}

test('建立房間、加入、開始、打完一手：每個人只看得到自己的底牌', async () => {
  await withServer(async ({ connect }) => {
    const { clients } = await openRoom(connect, ['甲', '乙', '丙']);
    const [host] = clients;

    host.send({ t: 'start' });
    await Promise.all(clients.map((c) => c.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop')));

    const realCards = new Map();
    for (const client of clients) {
      const { state } = client;
      for (const player of state.players) {
        if (player.id === state.you) {
          assert.equal(player.cards.every(Boolean), true);
          realCards.set(player.id, player.cards);
        } else {
          assert.deepEqual(player.cards, [null, null]);
        }
      }
    }
    assert.equal(realCards.size, 3);

    // 整手牌過程中，收到的原始訊息都不能出現別人的底牌
    const leaks = [];
    for (const client of clients) {
      client.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.t !== 'state' || message.state.stage === 'showdown') return;
        for (const [id, cards] of realCards) {
          if (id === client.state.you) continue;
          for (const card of cards) {
            if (event.data.includes(`"${card}"`) && !message.state.community.includes(card)) leaks.push(card);
          }
        }
      });
    }

    // 每位玩家各自看到輪到自己就行動，不依賴其他人的訊息先後
    for (const client of clients) {
      const respond = (state) => {
        if (state.legal) client.send({ t: 'action', action: state.legal.canCheck ? 'check' : 'call' });
      };
      respond(client.state);
      client.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.t === 'state') respond(message.state);
      });
    }
    await host.waitFor((m) => m.t === 'state' && m.state.stage === 'showdown', 'showdown');
    assert.deepEqual(leaks, []);
    assert.equal(host.state.community.length, 5);
    const totalStacks = host.state.players.reduce((sum, p) => sum + p.stack, 0);
    assert.equal(totalStacks, 3000);
  });
});

test('有公開網址時，邀請連結的基底就是公開網址', async () => {
  const publicUrl = 'https://example.trycloudflare.com';
  await withServer(async ({ connect, game }) => {
    const before = await connect();
    before.send({ t: 'create', name: '甲' });
    const local = await before.waitFor((m) => m.t === 'joined', 'joined');
    assert.notEqual(local.inviteBase, publicUrl);

    // 通道比伺服器晚就緒：之後才加入的人要拿到公開網址
    game.setPublicUrl(publicUrl);
    const after = await connect();
    after.send({ t: 'create', name: '乙' });
    const shared = await after.waitFor((m) => m.t === 'joined', 'joined');
    assert.equal(shared.inviteBase, publicUrl);
  });
});

test('非房主不能開始，也不能替別人行動', async () => {
  await withServer(async ({ connect }) => {
    const { clients } = await openRoom(connect, ['甲', '乙']);
    const [host, guest] = clients;
    guest.send({ t: 'start' });
    const error = await guest.waitFor((m) => m.t === 'error', 'error');
    assert.match(error.message, /房主/);

    host.send({ t: 'start' });
    await host.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');
    await guest.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');
    const notActor = host.state.legal ? guest : host;
    notActor.messages = [];
    notActor.send({ t: 'action', action: 'fold' });
    const denied = await notActor.waitFor((m) => m.t === 'error', 'denied');
    assert.match(denied.message, /輪到/);
  });
});

test('斷線後用 token 接回同一個座位，暱稱不能被搶', async () => {
  await withServer(async ({ connect }) => {
    const { code, clients, token } = await openRoom(connect, ['甲', '乙']);
    const [host, guest] = clients;
    const seatBefore = host.state.players.find((p) => p.id === host.state.you).seat;
    const idBefore = host.state.you;
    host.socket.close();
    await guest.next((m) => m.t === 'state' && m.state.players.some((p) => !p.connected), 'disconnect seen');

    const impostor = await connect();
    impostor.send({ t: 'join', code, name: '甲' });
    const denied = await impostor.waitFor((m) => m.t === 'error', 'denied');
    assert.match(denied.message, /暱稱/);

    const back = await connect();
    back.send({ t: 'join', code, token });
    await back.waitFor((m) => m.t === 'state', 'state');
    assert.equal(back.state.you, idBefore);
    assert.equal(back.state.players.find((p) => p.id === idBefore).seat, seatBefore);
    assert.equal(back.state.players.find((p) => p.id === idBefore).connected, true);
  });
});

test('fallbackToken 只有在原連線斷開時才能接回', async () => {
  await withServer(async ({ connect }) => {
    const { code, clients, token } = await openRoom(connect, ['甲']);
    const hostId = clients[0].state.you;

    const secondTab = await connect();
    secondTab.send({ t: 'join', code, fallbackToken: token, name: '分頁二' });
    await secondTab.waitFor((m) => m.t === 'state', 'state');
    assert.notEqual(secondTab.state.you, hostId);

    clients[0].socket.close();
    await secondTab.next((m) => m.t === 'state' && m.state.players.some((p) => !p.connected), 'disconnect seen');

    const reopened = await connect();
    reopened.send({ t: 'join', code, fallbackToken: token });
    await reopened.waitFor((m) => m.t === 'state', 'state');
    assert.equal(reopened.state.you, hostId);
  });
});

test('新分頁用 token 接管時舊連線會被關閉', async () => {
  await withServer(async ({ connect }) => {
    const { code, clients, token } = await openRoom(connect, ['甲']);
    const takeover = await connect();
    takeover.send({ t: 'join', code, token });
    const closeEvent = await clients[0].closed;
    assert.equal(closeEvent.code, 4001);
  });
});

test('輪到斷線玩家時計時到會自動行動，不會卡住整桌', async () => {
  await withServer(async ({ connect }) => {
    const { clients } = await openRoom(connect, ['甲', '乙'], { turnSeconds: 10 });
    const [host, guest] = clients;
    host.send({ t: 'start' });
    await guest.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');
    await host.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');

    const actor = host.state.legal ? host : guest;
    const other = actor === host ? guest : host;
    actor.socket.close();
    await other.next((m) => m.t === 'state' && m.state.stage === 'showdown', 'auto-fold');
    assert.equal(other.state.results.uncontested, true);
  });
});

test('輸光可以重新買入，排行榜算淨輸贏', async () => {
  await withServer(async ({ connect }) => {
    const { clients } = await openRoom(connect, ['甲', '乙']);
    const [host, guest] = clients;
    host.send({ t: 'start' });
    await host.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');
    await guest.waitFor((m) => m.t === 'state' && m.state.stage === 'preflop', 'preflop');

    const first = host.state.legal ? host : guest;
    const second = first === host ? guest : host;
    first.send({ t: 'action', action: 'raise', amount: first.state.legal.maxRaiseTo });
    await second.waitFor((m) => m.t === 'state' && m.state.legal, 'legal');
    second.send({ t: 'action', action: 'call' });
    await host.waitFor((m) => m.t === 'state' && m.state.results, 'results');
    const results = host.state.results;

    // 平手時雙方都不會破產，就不用測買入了
    const loser = clients.find((c) => !results.payouts[c.state.you]);
    if (!loser) return;

    loser.messages = [];
    await loser.waitFor((m) => m.t === 'state' && m.state.stage === 'waiting', 'waiting');
    assert.equal(loser.state.players.find((p) => p.id === loser.state.you).net, -1000);
    loser.send({ t: 'rebuy' });
    await loser.next((m) => m.t === 'state' && m.state.players.find((p) => p.id === m.state.you).stack === 1000, 'rebought');
    assert.equal(loser.state.players.find((p) => p.id === loser.state.you).net, -1000);
  });
});

test('聊天：會去除控制字元、限制長度，不執行 HTML 由前端 textContent 保證', async () => {
  await withServer(async ({ connect }) => {
    const { clients } = await openRoom(connect, ['甲', '乙']);
    const [host, guest] = clients;
    host.send({ t: 'chat', text: `  hi\u0000there${'x'.repeat(300)}` });
    const chat = await guest.waitFor((m) => m.t === 'chat', 'chat');
    assert.equal(chat.name, '甲');
    assert.ok(chat.text.startsWith('hithere'));
    assert.equal(chat.text.length, 120);
  });
});

test('亂七八糟的輸入不會讓伺服器掛掉', async () => {
  await withServer(async ({ connect }) => {
    const { clients, code } = await openRoom(connect, ['甲', '乙']);
    const stranger = await connect();
    for (const bad of ['not json', 'null', '[]', '42', '{"t":"action"}', '{"t":"nope"}', '{"t":"join"}', '{"t":"join","code":{"a":1}}', `{"t":"create","name":123,"settings":"x"}`]) {
      stranger.socket.send(bad);
    }
    const [host] = clients;
    for (const bad of ['{"t":"action","action":"raise","amount":"999"}', '{"t":"sit"}', '{"t":"rebuy"}', '{"t":"show"}', '{"t":"chat","text":{"x":1}}']) {
      host.socket.send(bad);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fresh = await connect();
    fresh.send({ t: 'join', code, name: '丙' });
    const state = await fresh.waitFor((m) => m.t === 'state', 'state');
    assert.equal(state.state.players.some((p) => p.name === '丙'), true);
  });
});

test('暱稱與設定會被清理、夾在合理範圍內', async () => {
  await withServer(async ({ connect }) => {
    const client = await connect();
    client.send({ t: 'create', name: '  <img src=x>超長超長超長超長超長超長超長  ', settings: { smallBlind: -5, bigBlind: 1e12, startingStack: 1, turnSeconds: 999, maxPlayers: 50 } });
    await client.waitFor((m) => m.t === 'state', 'state');
    const { settings, players } = client.state;
    assert.ok(players[0].name.length <= 14);
    assert.equal(settings.smallBlind, 1);
    assert.equal(settings.bigBlind, 200000);
    assert.equal(settings.startingStack, 400000);
    assert.equal(settings.turnSeconds, 120);
    assert.equal(settings.maxPlayers, 9);
  });
});

test('靜態檔案：可取得首頁，路徑穿越與未知副檔名都被擋', async () => {
  await withServer(async ({ port }) => {
    const get = (path) => new Promise((resolve, reject) => {
      // 用原始路徑發送，避免 URL 正規化把 ../ 消掉
      http.get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      }).on('error', reject);
    });
    const index = await get('/');
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    assert.equal((await get('/js/main.js')).statusCode, 200);
    assert.equal((await get('/../package.json')).statusCode, 404);
    assert.equal((await get('/..%2f..%2fpackage.json')).statusCode, 404);
    assert.equal((await get('/%2e%2e/server/index.js')).statusCode, 404);
    assert.equal((await get('/%E0%A4%A')).statusCode, 400);
  });
});
