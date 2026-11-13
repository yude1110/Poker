'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { Room, GameError } = require('./room');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 I L O 0 1
const ROOM_CODE_LENGTH = 5;
const MAX_ROOMS = 500;
const ROOM_IDLE_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;
const MAX_MESSAGES_PER_SECOND = 30;

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end();
    return;
  }
  const file = path.resolve(PUBLIC_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
  const type = MIME[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) {
    res.writeHead(404, SECURITY_HEADERS).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createGameServer({ port = 3000, host = '0.0.0.0', publicUrl = null, paceScale = 1 } = {}) {
  const rooms = new Map();
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  let inviteBase = publicUrl;

  const newRoomCode = () => {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const sendJoined = (socket, room, member) => {
    const fallback = lanAddresses()[0];
    socket.send(JSON.stringify({
      t: 'joined',
      code: room.code,
      playerId: member.id,
      token: member.token,
      inviteBase: inviteBase || (fallback ? `http://${fallback}:${server.address().port}` : null),
    }));
  };

  const handleEntry = (socket, session, msg) => {
    if (msg.t === 'create') {
      if (rooms.size >= MAX_ROOMS) throw new GameError('伺服器房間已滿，請稍後再試');
      const room = new Room(newRoomCode(), msg.settings, { paceScale });
      const member = room.addMember(msg.name, socket);
      rooms.set(room.code, room);
      Object.assign(session, { room, member });
      sendJoined(socket, room, member);
      room.sync();
      return;
    }
    if (msg.t !== 'join') throw new GameError('請先加入房間');

    const room = rooms.get(String(msg.code ?? '').trim().toUpperCase());
    if (!room) {
      socket.send(JSON.stringify({ t: 'error', code: 'ROOM_NOT_FOUND', message: '找不到這個房間' }));
      return;
    }
    let member = typeof msg.token === 'string' ? room.findByToken(msg.token) : null;
    if (!member && typeof msg.fallbackToken === 'string') {
      // 分頁關掉後再打開：只有原連線已斷才接回，同一台電腦開第二個分頁仍算新玩家
      const candidate = room.findByToken(msg.fallbackToken);
      if (candidate && !candidate.socket) member = candidate;
    }
    if (member) {
      Object.assign(session, { room, member });
      sendJoined(socket, room, member);
      room.resume(member, socket);
      return;
    }
    if (!msg.name) {
      socket.send(JSON.stringify({ t: 'error', code: 'NEED_NAME', message: '請輸入暱稱' }));
      return;
    }
    member = room.addMember(msg.name, socket);
    Object.assign(session, { room, member });
    sendJoined(socket, room, member);
    room.sync();
  };

  wss.on('connection', (socket) => {
    const session = { room: null, member: null };
    let windowStart = Date.now();
    let messagesInWindow = 0;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        messagesInWindow = 0;
      }
      messagesInWindow += 1;
      if (messagesInWindow > MAX_MESSAGES_PER_SECOND) {
        socket.close(4003, 'rate limited');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'ping') {
        socket.send(JSON.stringify({ t: 'pong', at: msg.at }));
        return;
      }

      try {
        if (session.room) session.room.handleMessage(session.member, msg);
        else handleEntry(socket, session, msg);
      } catch (err) {
        if (!(err instanceof GameError)) console.error('[server]', err);
        const message = err instanceof GameError ? err.message : '伺服器發生錯誤';
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'error', message }));
      }
    });

    socket.on('close', () => {
      if (session.room && session.member) session.room.handleDisconnect(session.member, socket);
    });
    socket.on('error', () => socket.terminate());
  });

  // 定期 ping：偵測斷線，也避免穿透通道因閒置而切斷連線
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  const sweep = setInterval(() => {
    for (const [code, room] of rooms) {
      if (room.connectedCount === 0 && Date.now() - room.lastActive > ROOM_IDLE_MS) {
        room.destroy();
        rooms.delete(code);
      }
    }
  }, 60 * 1000);

  return {
    rooms,
    server,
    setPublicUrl(url) { inviteBase = url; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const room of rooms.values()) room.destroy();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function printAddresses(port) {
  console.log('\n  HOLO HOLD\'EM 伺服器已啟動\n');
  console.log(`  本機:     http://localhost:${port}`);
  for (const address of lanAddresses()) console.log(`  區域網路: http://${address}:${port}`);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const game = createGameServer({ port, host: process.env.HOST || '0.0.0.0', publicUrl: process.env.PUBLIC_URL || null });
  game.listen().then((actualPort) => {
    printAddresses(actualPort);
    console.log('\n  想讓不同網路的朋友加入，請改用 npm run share\n');
  }).catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `連接埠 ${port} 已被佔用，可用 PORT=xxxx 指定其他連接埠` : err);
    process.exit(1);
  });
}

module.exports = { createGameServer, printAddresses };
