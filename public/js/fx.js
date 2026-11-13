import { $, el, reducedMotion } from './util.js';

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** 籌碼從一個元素飛到另一個元素。 */
export function flyChips(from, to, { count = 5, duration = 520, delay = 0, stagger = 45 } = {}) {
  if (reducedMotion() || !from || !to) return;
  const a = center(from.getBoundingClientRect());
  const b = center(to.getBoundingClientRect());
  const layer = $('fx');
  for (let i = 0; i < count; i++) {
    const chip = el('i', 'fx-chip');
    layer.append(chip);
    const jitterX = (Math.random() - 0.5) * 18;
    const jitterY = (Math.random() - 0.5) * 18;
    const midX = (a.x + b.x) / 2 + jitterX * 2;
    const midY = (a.y + b.y) / 2 - 24;
    chip.animate(
      [
        { transform: `translate(${a.x - 8}px, ${a.y - 8}px) scale(.8)`, opacity: 0 },
        { transform: `translate(${midX - 8}px, ${midY - 8}px) scale(1.05)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${b.x - 8 + jitterX}px, ${b.y - 8 + jitterY}px) scale(.7)`, opacity: 0.2 },
      ],
      { duration, delay: delay + i * stagger, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' },
    ).finished.finally(() => chip.remove());
  }
}

/** 讓元素從 origin 的位置滑到它自己的位置（發牌用）。 */
export function dealFrom(node, origin, { delay = 0, duration = 420 } = {}) {
  if (reducedMotion()) return Promise.resolve();
  const a = center(origin.getBoundingClientRect());
  const b = center(node.getBoundingClientRect());
  return node.animate(
    [
      { transform: `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(.45) rotate(-16deg)`, opacity: 0 },
      { opacity: 1, offset: 0.25 },
      { transform: 'none', opacity: 1 },
    ],
    { duration, delay, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' },
  ).finished.catch(() => {});
}

export function pop(node, scale = 1.14) {
  if (reducedMotion()) return;
  node.animate(
    [{ scale: 1 }, { scale, offset: 0.35 }, { scale: 1 }],
    { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
}

const tweens = new WeakMap();

/** 數字滾動到目標值。 */
export function tweenNumber(node, to, format, { duration = 420, delay = 0 } = {}) {
  const state = tweens.get(node) || { value: to, raf: 0, timer: 0 };
  tweens.set(node, state);
  cancelAnimationFrame(state.raf);
  clearTimeout(state.timer);
  const from = state.value;
  if (from === to || reducedMotion() || document.hidden) {
    state.value = to;
    node.textContent = format(to);
    return;
  }
  state.timer = setTimeout(() => {
    const start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      state.value = from + (to - from) * eased;
      node.textContent = format(state.value);
      if (t < 1) state.raf = requestAnimationFrame(frame);
      else state.value = to;
    };
    state.raf = requestAnimationFrame(frame);
  }, delay);
}

export function setNumber(node, value, format) {
  const state = tweens.get(node);
  if (state) {
    cancelAnimationFrame(state.raf);
    clearTimeout(state.timer);
  }
  tweens.set(node, { value, raf: 0, timer: 0 });
  node.textContent = format(value);
}

/** 背景：大廳有透視網格與光點，進牌桌後只留低調光點並降到 30fps。 */
export function startBackground(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let width = 0;
  let height = 0;
  let mode = 'lobby';
  let last = 0;
  const motes = Array.from({ length: 46 }, () => ({
    x: Math.random(), y: Math.random(), z: 0.25 + Math.random() * 0.75, p: Math.random() * Math.PI * 2,
  }));

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(performance.now());
  };

  const drawGrid = (t) => {
    const horizon = height * 0.56;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(46,230,255,.13)';
    ctx.beginPath();
    const offset = (t / 2600) % 1;
    for (let i = 0; i < 14; i++) {
      const d = ((i + offset) / 14) ** 2.4;
      const y = horizon + d * (height - horizon);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    const cx = width / 2;
    for (let i = -14; i <= 14; i++) {
      ctx.moveTo(cx + i * 26, horizon);
      ctx.lineTo(cx + i * 190, height);
    }
    ctx.stroke();
    const glow = ctx.createLinearGradient(0, horizon - 90, 0, horizon + 40);
    glow.addColorStop(0, 'rgba(5,8,17,0)');
    glow.addColorStop(0.7, 'rgba(46,230,255,.1)');
    glow.addColorStop(1, 'rgba(5,8,17,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, horizon - 90, width, 130);
  };

  const draw = (t) => {
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, width, height);
    const aura = ctx.createRadialGradient(width * 0.5, height * 0.45, 0, width * 0.5, height * 0.45, Math.max(width, height) * 0.7);
    aura.addColorStop(0, 'rgba(32,62,120,.5)');
    aura.addColorStop(1, 'rgba(5,8,17,0)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, width, height);
    if (mode === 'lobby') drawGrid(t);
    for (const m of motes) {
      const y = (m.y - (t / 90000) * m.z + 1) % 1;
      const x = m.x + Math.sin(t / 7000 + m.p) * 0.012;
      ctx.globalAlpha = (0.2 + 0.5 * (0.5 + 0.5 * Math.sin(t / 1600 + m.p))) * m.z;
      ctx.fillStyle = m.p > 3 ? '#2ee6ff' : '#8f73ff';
      const size = 1.8 * m.z;
      ctx.fillRect(x * width, y * height, size, size);
    }
    ctx.globalAlpha = 1;
  };

  const loop = (t) => {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    if (mode === 'game' && t - last < 33) return;
    last = t;
    draw(t);
  };

  window.addEventListener('resize', resize);
  resize();
  if (!reducedMotion()) requestAnimationFrame(loop);

  return {
    setMode(next) {
      mode = next;
      draw(performance.now());
    },
  };
}
