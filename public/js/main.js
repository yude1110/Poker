import { $, el, toast, copyText, fmt } from './util.js';
import { Net } from './net.js';
import { TableView, describeEvent } from './table.js';
import { Dock } from './dock.js';
import { createCard } from './cards.js';
import { startBackground } from './fx.js';
import { sound } from './sound.js';

const ICONS = {
  soundOn: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.500 8.500a5 5 0 0 1 0 7M19 6a8.500 8.500 0 0 1 0 12"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 10 4 4M21 10l-4 4"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.500h5"/></svg>',
  leave: '<svg viewBox="0 0 24 24"><path d="M10 4H4v16h6"/><path d="M14 8l4 4-4 4M8 12h10"/></svg>',
};
const MAX_FEED_LINES = 200;

const store = {
  get(area, key) {
    try {
      return area.getItem(key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      if (value === null) area.removeItem(key);
      else area.setItem(key, value);
    } catch { /* 瀏覽器封鎖儲存空間時，只是重新整理後要重新加入 */ }
  },
};
const tokenKey = (code) => `holo.token.${code}`;

const background = startBackground($('bg'));
let session = null;
let inviteBase = null;
let lastState = null;
let autoResuming = false;

const net = new Net({ onMessage, onStatus, onPing });
const table = new TableView({ onTurnStart: notifyTurn });
const dock = new Dock({ send: (message) => net.send(message) });

/* ---------- 畫面切換 ---------- */

function showLobby() {
  $('lobby').hidden = false;
  $('game').hidden = true;
  background.setMode('lobby');
  document.title = "HOLO Hold'em";
}

function showGame() {
  $('lobby').hidden = true;
  $('game').hidden = false;
  background.setMode('game');
}

function setLobbyTab(tab) {
  const isCreate = tab === 'create';
  $('form-create').hidden = !isCreate;
  $('form-join').hidden = isCreate;
  $('tab-create').classList.toggle('is-active', isCreate);
  $('tab-join').classList.toggle('is-active', !isCreate);
  $('tab-create').setAttribute('aria-selected', String(isCreate));
  $('tab-join').setAttribute('aria-selected', String(!isCreate));
}

/* ---------- 網路訊息 ---------- */

function onMessage(message) {
  switch (message.t) {
    case 'joined':
      onJoined(message);
      break;
    case 'state':
      onState(message.state, message.events);
      break;
    case 'chat':
      appendFeed({ cls: 'f-chat', name: message.name, text: message.text });
      table.showBubble(message.id, message.text);
      markUnread();
      break;
    case 'error':
      onServerError(message);
      break;
    default:
  }
}

function onJoined({ code, token, inviteBase: base }) {
  autoResuming = false;
  const isNewSeat = !session || session.code !== code;
  session = { code, token };
  inviteBase = base;
  store.set(sessionStorage, tokenKey(code), token);
  store.set(localStorage, tokenKey(code), token);
  net.setRejoin({ t: 'join', code, token });
  history.replaceState(null, '', `?room=${code}`);
  $('room-code').textContent = code;
  if (isNewSeat) {
    table.reset();
    lastState = null;
    $('feed').replaceChildren();
  }
  $('conn-banner').hidden = true;
  showGame();
}

function onState(state, events) {
  lastState = state;
  $('hud-blinds').textContent = `${fmt(state.settings.smallBlind)}/${fmt(state.settings.bigBlind)}`;
  $('hud-hand').textContent = String(state.handNo);
  table.update(state, events);
  dock.update(state);
  renderRank(state);
  for (const event of events) {
    const described = describeEvent(event);
    if (!described) continue;
    for (const entry of [].concat(described)) appendFeed(entry);
  }
  if (!state.legal) document.title = "HOLO Hold'em";
}

function onServerError({ code, message }) {
  if (code === 'ROOM_NOT_FOUND' || code === 'NEED_NAME') {
    const wasResuming = autoResuming;
    autoResuming = false;
    const requested = new URLSearchParams(location.search).get('room');
    net.setRejoin(null);
    showLobby();
    if (code === 'ROOM_NOT_FOUND') {
      session = null;
      if (requested) {
        store.set(sessionStorage, tokenKey(requested), null);
        store.set(localStorage, tokenKey(requested), null);
      }
      history.replaceState(null, '', location.pathname);
      toast(wasResuming ? '這個房間已經結束了' : message, true);
    } else {
      setLobbyTab('join');
      $('code').value = requested || '';
      $('name').focus();
    }
    return;
  }
  dock.restore();
  toast(message, true);
}

function onStatus(status) {
  const banner = $('conn-banner');
  if (status === 'reconnecting' && session) {
    banner.textContent = '連線中斷，正在重新連線…';
    banner.hidden = false;
  } else if (status === 'replaced') {
    banner.textContent = '這個座位已在其他分頁開啟';
    banner.hidden = false;
  } else if (status === 'online') {
    banner.hidden = true;
  }
}

function onPing(ms) {
  $('hud-ping').textContent = `${ms}ms`;
  $('ping-dot').className = ms < 80 ? 'good' : ms < 200 ? 'ok' : 'bad';
}

function notifyTurn() {
  if (document.hidden) document.title = '▶ 輪到你了！';
  navigator.vibrate?.(60);
}

/* ---------- 大廳表單 ---------- */

function selectedOption(name) {
  return document.querySelector(`[data-option="${name}"] .is-on`).dataset.value;
}

function playerName() {
  const name = $('name').value.trim();
  if (!name) {
    toast('請先輸入暱稱', true);
    $('name').focus();
    return null;
  }
  store.set(localStorage, 'holo.name', name);
  return name;
}

function createRoom() {
  const name = playerName();
  if (!name) return;
  const [smallBlind, bigBlind] = selectedOption('blinds').split('/').map(Number);
  net.setRejoin(null);
  net.send({
    t: 'create',
    name,
    settings: {
      smallBlind,
      bigBlind,
      startingStack: bigBlind * Number(selectedOption('depth')),
      turnSeconds: Number(selectedOption('turn')),
      maxPlayers: Number(selectedOption('seats')),
      allowRebuy: $('allow-rebuy').checked,
    },
  });
}

function joinRoom() {
  const name = playerName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 5) {
    toast('房號是 5 個字元', true);
    $('code').focus();
    return;
  }
  net.setRejoin(null);
  net.send({
    t: 'join',
    code,
    name,
    token: store.get(sessionStorage, tokenKey(code)),
    fallbackToken: store.get(localStorage, tokenKey(code)),
  });
}

function leaveRoom() {
  if (!session) return;
  if (lastState?.players.find((p) => p.id === lastState.you)?.inHand && lastState.stage !== 'showdown') {
    if (!window.confirm('這手牌還沒結束，離開會直接棄牌。確定要離開嗎？')) return;
  }
  net.send({ t: 'leave' });
  net.disconnect();
  store.set(sessionStorage, tokenKey(session.code), null);
  store.set(localStorage, tokenKey(session.code), null);
  session = null;
  lastState = null;
  table.reset();
  history.replaceState(null, '', location.pathname);
  showLobby();
}

async function copyInvite() {
  if (!session) return;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = isLocal && inviteBase ? inviteBase : location.origin;
  const link = `${base}/?room=${session.code}`;
  const ok = await copyText(link);
  toast(ok ? `已複製：${link}` : link, !ok);
}

/* ---------- 側欄 ---------- */

function appendFeed({ cls = '', text, name }) {
  if (!text) return;
  const feed = $('feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  const line = el('div', cls);
  if (name) line.append(el('b', '', `${name}：`), text);
  else line.textContent = text;
  feed.append(line);
  while (feed.children.length > MAX_FEED_LINES) feed.firstChild.remove();
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderRank(state) {
  const sorted = [...state.players].sort((a, b) => b.net - a.net);
  $('rank').replaceChildren(...sorted.map((player, i) => {
    const row = el('li');
    const sign = player.net > 0 ? '+' : '';
    row.append(
      el('i', '', String(i + 1)),
      el('span', '', player.name),
      el('b', player.net > 0 ? 'up' : player.net < 0 ? 'down' : '', `${sign}${fmt(player.net)}`),
    );
    return row;
  }));
}

function setPanelTab(tab) {
  const isFeed = tab === 'feed';
  $('feed').hidden = !isFeed;
  $('rank').hidden = isFeed;
  $('tab-feed').classList.toggle('is-active', isFeed);
  $('tab-rank').classList.toggle('is-active', !isFeed);
  $('tab-feed').setAttribute('aria-selected', String(isFeed));
  $('tab-rank').setAttribute('aria-selected', String(!isFeed));
}

function markUnread() {
  if ($('panel').classList.contains('is-closed')) $('btn-panel').classList.add('has-unread');
}

function togglePanel(force) {
  const closed = $('panel').classList.toggle('is-closed', force);
  if (!closed) $('btn-panel').classList.remove('has-unread');
}

/* ---------- 綁定事件 ---------- */

$('btn-panel').innerHTML = ICONS.panel;
$('btn-leave').innerHTML = ICONS.leave;

function renderSoundIcon() {
  $('btn-sound').innerHTML = sound.muted ? ICONS.soundOff : ICONS.soundOn;
}
renderSoundIcon();

['K', 'A', 'Q', 'J'].forEach((rank, i) => {
  const suit = 'shdc'[i];
  const card = createCard(rank + suit);
  card.style.setProperty('--i', i);
  $('hero-cards').append(card);
});

$('tab-create').addEventListener('click', () => setLobbyTab('create'));
$('tab-join').addEventListener('click', () => setLobbyTab('join'));
for (const group of document.querySelectorAll('.seg')) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    for (const other of group.children) other.classList.toggle('is-on', other === button);
  });
}
$('form-create').addEventListener('submit', (event) => {
  event.preventDefault();
  createRoom();
});
$('form-join').addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoom();
});

$('invite').addEventListener('click', copyInvite);
$('waiting-invite').addEventListener('click', copyInvite);
$('btn-start').addEventListener('click', () => net.send({ t: 'start' }));
$('btn-leave').addEventListener('click', leaveRoom);
$('btn-panel').addEventListener('click', () => togglePanel());
$('btn-sound').addEventListener('click', () => {
  sound.toggle();
  renderSoundIcon();
});
$('tab-feed').addEventListener('click', () => setPanelTab('feed'));
$('tab-rank').addEventListener('click', () => setPanelTab('rank'));
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  net.send({ t: 'chat', text });
  input.value = '';
});

window.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !lastState?.legal) document.title = "HOLO Hold'em";
});

/* ---------- 啟動 ---------- */

$('name').value = store.get(localStorage, 'holo.name') || '';
if (window.innerWidth <= 1100) $('panel').classList.add('is-closed');

const requestedRoom = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (requestedRoom) {
  setLobbyTab('join');
  $('code').value = requestedRoom;
  const token = store.get(sessionStorage, tokenKey(requestedRoom));
  const fallbackToken = store.get(localStorage, tokenKey(requestedRoom));
  if (token || fallbackToken) {
    // 只靠 token 接回座位，不帶暱稱，失敗時才讓使用者決定要不要用新座位加入
    autoResuming = true;
    net.send({ t: 'join', code: requestedRoom, token, fallbackToken });
  } else {
    $('name').focus();
  }
} else {
  showLobby();
}
