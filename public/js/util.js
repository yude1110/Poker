export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function toast(message, isError = false) {
  const node = el('div', `toast${isError ? ' is-error' : ''}`, message);
  $('toasts').append(node);
  node.addEventListener('animationend', () => node.remove());
}

/** 區網 http 連線沒有 navigator.clipboard，退回舊方法。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export const hueOf = (name) => {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
};
