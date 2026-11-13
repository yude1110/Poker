'use strict';

const { randomBytes } = require('node:crypto');
const { Game, GameError } = require('./game');

// 牌局節奏（毫秒），留時間給前端播放動畫
const PACE = {
  advance: 900,
  allInStreet: 1700,
  uncontested: 3000,
  showdown: 6000,
  perExtraPot: 1500,
  nextHand: 1200,
};
const DISCONNECTED_TURN_MS = 10000;
const CONSECUTIVE_TIMEOUTS_TO_SIT_OUT = 2;
const CHAT_INTERVAL_MS = 400;

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function sanitizeSettings(raw = {}) {
  const smallBlind = clampInt(raw.smallBlind, 1, 100000, 5);
  const bigBlind = clampInt(raw.bigBlind, smallBlind, 200000, smallBlind * 2);
  return {
    smallBlind,
    bigBlind,
    startingStack: clampInt(raw.startingStack, bigBlind * 2, 100000000, bigBlind * 100),
    turnSeconds: clampInt(raw.turnSeconds, 10, 120, 25),
    maxPlayers: clampInt(raw.maxPlayers, 2, 9, 9),
    allowRebuy: raw.allowRebuy !== false,
  };
}

function sanitizeName(raw) {
  // 移除控制字元與前後空白；顯示時一律走 textContent
  return String(raw ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, 14);
}

/** 一個房間：管理連線成員、計時器與節奏，規則全部交給 Game。 */
class Room {
  constructor(code, settings, { paceScale = 1 } = {}) {
    this.code = code;
    this.settings = sanitizeSettings(settings);
    this.paceScale = paceScale;
    this.game = new Game({
      smallBlind: this.settings.smallBlind,
      bigBlind: this.settings.bigBlind,
      maxPlayers: this.settings.maxPlayers,
    });
    this.members = new Map();
    this.hostId = null;
    this.started = false;
    this.pendingEvents = [];
    this.lastActive = Date.now();
    this.paceTimer = null;
    this.paceKind = null;
    this.turnTimer = null;
    this.turnKey = null;
    this.turnDeadline = 0;
    this.turnTotalMs = 0;
    this.turnTimerId = 0;
  }

  get connectedCount() {
    return [...this.members.values()].filter((m) => m.socket).length;
  }

  destroy() {
    clearTimeout(this.paceTimer);
    clearTimeout(this.turnTimer);
  }

  addMember(rawName, socket) {
    const name = sanitizeName(rawName);
    if (!name) throw new GameError('請輸入暱稱');
    for (const member of this.members.values()) {
      if (member.name === name) throw new GameError('這個暱稱已經有人使用了');
    }
    const id = randomBytes(6).toString('hex');
    this.game.addPlayer({ id, name, stack: this.settings.startingStack });
    const member = {
      id,
      name,
      socket,
      token: randomBytes(24).toString('hex'),
      timeouts: 0,
      autoSatOut: false,
      buyIn: this.settings.startingStack,
      lastChatAt: 0,
    };
    this.members.set(id, member);
    if (!this.hostId) this.hostId = id;
    this.pendingEvents.push({ t: 'info', kind: 'join', name });
    return member;
  }

  findByToken(token) {
    for (const member of this.members.values()) {
      if (member.token === token) return member;
    }
    return null;
  }

  /** 重新連線：新連線取代舊連線，斷線時被自動離座的人回到牌桌。 */
  resume(member, socket) {
    const previous = member.socket;
    member.socket = socket;
    if (previous && previous !== socket) previous.close(4001, 'replaced');
    if (member.autoSatOut) {
      member.autoSatOut = false;
      const player = this.game.getPlayer(member.id);
      if (player) player.sittingOut = false;
    }
    member.timeouts = 0;
    this.pendingEvents.push({ t: 'info', kind: 'reconnect', name: member.name });
    this.sync();
  }

  handleDisconnect(member, socket) {
    if (member.socket !== socket) return;
    member.socket = null;
    this.lastActive = Date.now();
    this.pendingEvents.push({ t: 'info', kind: 'disconnect', name: member.name });
    this._ensureHost();

    // 斷線的人輪到時不要讓大家等滿整個計時
    const hand = this.game.hand;
    const player = this.game.getPlayer(member.id);
    if (hand && player && hand.toAct === player.seat) {
      const remaining = this.turnDeadline - Date.now();
      if (remaining > DISCONNECTED_TURN_MS * this.paceScale) this._armTurnTimer(DISCONNECTED_TURN_MS * this.paceScale);
    }
    this.sync();
  }

  leave(member) {
    const { socket } = member;
    member.socket = null;
    this.members.delete(member.id);
    this.game.removePlayer(member.id);
    this.pendingEvents.push({ t: 'info', kind: 'leave', name: member.name });
    this._ensureHost();
    this.lastActive = Date.now();
    this.sync();
    socket?.close(4002, 'left');
  }

  _ensureHost() {
    const host = this.members.get(this.hostId);
    if (host && host.socket) return;
    const next = [...this.members.values()].find((m) => m.socket);
    if (next) {
      this.hostId = next.id;
      this.pendingEvents.push({ t: 'info', kind: 'host', name: next.name });
    } else if (!host) {
      this.hostId = null;
    }
  }

  handleMessage(member, msg) {
    this.lastActive = Date.now();
    const player = this.game.getPlayer(member.id);
    switch (msg.t) {
      case 'start':
        if (member.id !== this.hostId) throw new GameError('只有房主可以開始牌局');
        if (this.started) return;
        if (!this.game.canStartHand()) throw new GameError('至少需要兩位玩家才能開始');
        this.started = true;
        this.sync();
        return;
      case 'action':
        member.timeouts = 0;
        this.game.act(member.id, msg.action, msg.amount);
        this.sync();
        return;
      case 'sit':
        if (!player) return;
        player.sittingOut = !msg.in;
        member.autoSatOut = false;
        member.timeouts = 0;
        this.sync();
        return;
      case 'rebuy':
        this._rebuy(member, player);
        return;
      case 'show':
        this.game.show(member.id);
        this.sync();
        return;
      case 'chat':
        this._chat(member, msg.text);
        return;
      case 'leave':
        this.leave(member);
        return;
      default:
        throw new GameError('未知的訊息');
    }
  }

  _rebuy(member, player) {
    if (!this.settings.allowRebuy) throw new GameError('這個房間不允許重新買入');
    if (!player || player.stack > 0 || player.inHand) throw new GameError('現在不能重新買入');
    player.stack = this.settings.startingStack;
    player.sittingOut = false;
    member.autoSatOut = false;
    member.buyIn += this.settings.startingStack;
    this.pendingEvents.push({ t: 'info', kind: 'rebuy', name: member.name, amount: this.settings.startingStack });
    this.sync();
  }

  _chat(member, rawText) {
    const text = String(rawText ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (now - member.lastChatAt < CHAT_INTERVAL_MS) return;
    member.lastChatAt = now;
    this._send({ t: 'chat', id: member.id, name: member.name, text });
  }

  /** 把牌局變化送給所有人，並安排下一個計時動作。 */
  sync() {
    const events = [...this.pendingEvents, ...this.game.drainEvents()];
    this.pendingEvents = [];
    this._schedule();
    for (const member of this.members.values()) {
      if (member.socket) this._sendTo(member, { t: 'state', state: this.viewFor(member.id), events });
    }
  }

  _schedule() {
    const hand = this.game.hand;

    if (hand && hand.toAct !== null) {
      const key = `${hand.no}:${hand.turnId}`;
      if (this.turnKey !== key) {
        this.turnKey = key;
        const seated = this.game.seats[hand.toAct];
        const connected = this.members.get(seated.id)?.socket;
        const total = this.settings.turnSeconds * 1000 * this.paceScale;
        this._armTurnTimer(connected ? total : Math.min(total, DISCONNECTED_TURN_MS * this.paceScale), total);
      }
    } else {
      clearTimeout(this.turnTimer);
      this.turnKey = null;
    }

    let kind = null;
    let delay = 0;
    if (hand && hand.stage === 'showdown') {
      kind = 'end';
      const { uncontested, pots } = hand.results;
      delay = uncontested ? PACE.uncontested : PACE.showdown + (pots.length - 1) * PACE.perExtraPot;
    } else if (hand && hand.pendingAdvance) {
      kind = 'advance';
      delay = hand.revealAllIn ? PACE.allInStreet : PACE.advance;
    } else if (!hand && this.started) {
      this._autoSitOutDisconnected();
      if (this.game.canStartHand()) {
        kind = 'start';
        delay = PACE.nextHand;
      }
    }

    if (kind === this.paceKind) return;
    clearTimeout(this.paceTimer);
    this.paceKind = kind;
    if (kind) this.paceTimer = setTimeout(() => this._onPace(kind), delay * this.paceScale);
  }

  _onPace(kind) {
    this.paceKind = null;
    if (kind === 'advance') this.game.advance();
    else if (kind === 'end') this.game.endHand();
    else if (kind === 'start' && this.game.canStartHand()) this.game.startHand();
    this.sync();
  }

  _autoSitOutDisconnected() {
    for (const member of this.members.values()) {
      const player = this.game.getPlayer(member.id);
      if (!member.socket && player && !player.sittingOut) {
        player.sittingOut = true;
        member.autoSatOut = true;
      }
    }
  }

  _armTurnTimer(ms, total = this.turnTotalMs) {
    clearTimeout(this.turnTimer);
    this.turnDeadline = Date.now() + ms;
    this.turnTotalMs = total;
    this.turnTimerId += 1;
    this.turnTimer = setTimeout(() => this._onTurnTimeout(), ms);
  }

  _onTurnTimeout() {
    const hand = this.game.hand;
    if (!hand || hand.toAct === null) return;
    const player = this.game.seats[hand.toAct];
    const member = this.members.get(player.id);
    const legal = this.game.legalActions(player.id);
    this.game.act(player.id, legal.canCheck ? 'check' : 'fold');
    if (member) {
      member.timeouts += 1;
      if (member.socket && member.timeouts >= CONSECUTIVE_TIMEOUTS_TO_SIT_OUT) player.sittingOut = true;
    }
    this.pendingEvents.push({ t: 'info', kind: 'timeout', name: player.name });
    this.sync();
  }

  viewFor(id) {
    const view = this.game.viewFor(id);
    for (const p of view.players) {
      const member = this.members.get(p.id);
      p.connected = Boolean(member && member.socket);
      p.net = member ? p.stack - member.buyIn : 0;
    }
    return {
      ...view,
      code: this.code,
      you: id,
      hostId: this.hostId,
      started: this.started,
      settings: this.settings,
      turnRemainingMs: view.toActSeat !== null ? Math.max(0, this.turnDeadline - Date.now()) : 0,
      turnTotalMs: this.turnTotalMs,
      turnTimerId: this.turnTimerId,
    };
  }

  _send(message) {
    for (const member of this.members.values()) {
      if (member.socket) this._sendTo(member, message);
    }
  }

  _sendTo(member, message) {
    if (member.socket.readyState === member.socket.OPEN) member.socket.send(JSON.stringify(message));
  }
}

module.exports = { Room, GameError, sanitizeName };
