import { el } from './util.js';

const SUIT_PATHS = {
  s: 'M12 1.500s9.500 6.600 9.500 12.600c0 3-2.300 5.100-4.900 5.100-1.500 0-2.700-.6-3.500-1.600.3 1.700 1 3 2.400 4.900H8.500c1.400-1.900 2.100-3.200 2.400-4.900-.8 1-2 1.600-3.500 1.600-2.600 0-4.900-2.100-4.900-5.100C2.500 8.100 12 1.500 12 1.500z',
  h: 'M12 21.500s-9.500-6-11-11.400C-.1 6 2.400 2.500 6.300 2.500c2.300 0 4.500 1.300 5.700 3.400 1.200-2.100 3.400-3.400 5.700-3.400 3.900 0 6.400 3.500 5.300 7.600-1.500 5.400-11 11.400-11 11.400z',
  d: 'M12 1 21.500 12 12 23 2.500 12z',
  c: 'M12 1.500a5 5 0 0 1 4.700 6.800 5 5 0 1 1-3.500 8.700c.3 1.700 1 3 2.400 5H8.400c1.400-2 2.100-3.300 2.400-5a5 5 0 1 1-3.500-8.700A5 5 0 0 1 12 1.500z',
};
const RANK_LABELS = { T: '10' };
const SVG_NS = 'http://www.w3.org/2000/svg';

function suitIcon(suit, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', SUIT_PATHS[suit]);
  svg.append(path);
  return svg;
}

function paintFront(card, code) {
  const [rank, suit] = code;
  card.dataset.card = code;
  card.classList.toggle('red', suit === 'h' || suit === 'd');
  card.setAttribute('aria-label', code);
  card.front.replaceChildren(
    el('span', 'card-rank', RANK_LABELS[rank] || rank),
    suitIcon(suit, 'pip-small'),
    suitIcon(suit, 'pip-big'),
  );
}

/** 建立一張牌；code 為 null 時是背面朝上。 */
export function createCard(code = null, { faceUp = true } = {}) {
  const card = el('div', 'card no-anim');
  const inner = el('div', 'card-inner');
  card.front = el('div', 'face front');
  inner.append(card.front, el('div', 'face back'));
  card.append(inner);
  if (code) {
    paintFront(card, code);
    if (faceUp) card.classList.add('is-up');
  }
  requestAnimationFrame(() => card.classList.remove('no-anim'));
  return card;
}

/** 翻開一張牌；已經是同一張就不做事。 */
export function revealCard(card, code, delay = 0) {
  if (card.dataset.card === code && card.classList.contains('is-up')) return false;
  paintFront(card, code);
  if (delay) setTimeout(() => card.classList.add('is-up'), delay);
  else card.classList.add('is-up');
  return true;
}
