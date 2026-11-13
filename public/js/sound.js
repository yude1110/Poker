// 所有音效都用 WebAudio 即時合成，不需要音檔。
const STORAGE_KEY = 'holo.muted';

let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem(STORAGE_KEY) === '1';
} catch { /* 瀏覽器封鎖儲存空間時就用預設值 */ }

function audio() {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx.state === 'running' ? ctx : null;
}

function tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.08, to = null } = {}) {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + at;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(amp).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function noise({ at = 0, dur = 0.07, freq = 3000, gain = 0.12 } = {}) {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + at;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const amp = ac.createGain();
  amp.gain.setValueAtTime(gain, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(start);
}

export const sound = {
  get muted() { return muted; },
  toggle() {
    muted = !muted;
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch { /* 同上 */ }
    return muted;
  },
  /** 瀏覽器要求音訊必須由使用者操作啟動。 */
  unlock() { audio(); },
  deal(at = 0) { noise({ at, dur: 0.06, freq: 4200, gain: 0.1 }); },
  flip(at = 0) { noise({ at, dur: 0.09, freq: 2400, gain: 0.1 }); tone(880, { at, dur: 0.05, gain: 0.02 }); },
  chip(at = 0) {
    tone(2600, { at, dur: 0.05, type: 'triangle', gain: 0.05 });
    tone(3400, { at: at + 0.035, dur: 0.05, type: 'triangle', gain: 0.04 });
  },
  check() { tone(320, { dur: 0.05, type: 'square', gain: 0.03 }); tone(320, { at: 0.08, dur: 0.05, type: 'square', gain: 0.03 }); },
  fold() { noise({ dur: 0.16, freq: 900, gain: 0.07 }); },
  allIn() { tone(120, { dur: 0.5, type: 'sawtooth', gain: 0.07, to: 480 }); },
  turn() { tone(740, { dur: 0.1, gain: 0.08 }); tone(1110, { at: 0.11, dur: 0.16, gain: 0.08 }); },
  tick() { tone(1400, { dur: 0.04, type: 'square', gain: 0.025 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.09, dur: 0.26, type: 'triangle', gain: 0.08 })); },
};
