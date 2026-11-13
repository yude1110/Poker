const PING_INTERVAL_MS = 4000;
const MAX_RETRY_MS = 5000;

/** WebSocket 連線：斷線自動重連，重連後重新加入房間。 */
export class Net {
  constructor({ onMessage, onStatus, onPing }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onPing = onPing;
    this.socket = null;
    this.queue = [];
    this.rejoin = null;
    this.retry = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.wanted = false;
  }

  /** 設定重連時要送的加入訊息；null 代表不在房間內。 */
  setRejoin(message) {
    this.rejoin = message;
    this.wanted = Boolean(message);
  }

  /** 主動離開房間：送完訊息後關閉連線，下次進房用新連線。 */
  disconnect() {
    this.wanted = false;
    this.rejoin = null;
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  send(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.queue.push(message);
    this._connect();
  }

  _connect() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.retryTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retry = 0;
      this.onStatus('online');
      if (this.rejoin) socket.send(JSON.stringify(this.rejoin));
      for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message));
      this._ping();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._ping(), PING_INTERVAL_MS);
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'pong') this.onPing(Math.round(performance.now() - message.at));
      else this.onMessage(message);
    });

    socket.addEventListener('close', (event) => {
      clearInterval(this.pingTimer);
      if (this.socket !== socket) return;
      if (event.code === 4001) {
        this.wanted = false;
        this.onStatus('replaced');
        return;
      }
      if (!this.wanted) return;
      this.onStatus('reconnecting');
      const delay = Math.min(MAX_RETRY_MS, 400 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this._connect(), delay);
    });
  }

  _ping() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: 'ping', at: performance.now() }));
    }
  }
}
