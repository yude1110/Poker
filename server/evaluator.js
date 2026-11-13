'use strict';

const RANKS = '23456789TJQKA';
const CATEGORY_NAMES = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順', '皇家同花順'];

const rankValue = (card) => RANKS.indexOf(card[0]) + 2;

function rankLabel(value) {
  return { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' }[value] || String(value);
}

function groupByRank(cards) {
  const counts = new Map();
  for (const card of cards) {
    const value = rankValue(card);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  // 張數多的在前，同張數時點數大的在前
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

function score5(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const groups = groupByRank(cards);
  const flush = cards.every((card) => card[1] === cards[0][1]);

  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // A2345
  }

  const groupRanks = groups.map((group) => group[0]);
  let category;
  let tiebreak;
  if (flush && straightHigh) {
    category = straightHigh === 14 ? 9 : 8;
    tiebreak = [straightHigh];
  } else if (groups[0][1] === 4) {
    category = 7;
    tiebreak = groupRanks;
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 6;
    tiebreak = groupRanks;
  } else if (flush) {
    category = 5;
    tiebreak = ranks;
  } else if (straightHigh) {
    category = 4;
    tiebreak = [straightHigh];
  } else if (groups[0][1] === 3) {
    category = 3;
    tiebreak = groupRanks;
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 2;
    tiebreak = groupRanks;
  } else if (groups[0][1] === 2) {
    category = 1;
    tiebreak = groupRanks;
  } else {
    category = 0;
    tiebreak = ranks;
  }

  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] || 0);
  return { score, category, tiebreak };
}

function describe(category, tiebreak) {
  const name = CATEGORY_NAMES[category];
  const [a, b] = tiebreak.map(rankLabel);
  switch (category) {
    case 0: return `${name} ${a}`;
    case 1: return `${name} ${a}`;
    case 2: return `${name} ${a} 與 ${b}`;
    case 3: return `${name} ${a}`;
    case 4: return `${name} 到 ${a}`;
    case 5: return `${name} ${a} 大`;
    case 6: return `${name} ${a} 帶 ${b}`;
    case 7: return `${name} ${a}`;
    case 8: return `${name} 到 ${a}`;
    default: return name;
  }
}

function* combinations5(cards) {
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            yield [cards[a], cards[b], cards[c], cards[d], cards[e]];
          }
        }
      }
    }
  }
}

/** 從 5~7 張牌中找出最佳的 5 張組合。 */
function evaluate(cards) {
  let best = null;
  for (const combo of combinations5(cards)) {
    const result = score5(combo);
    if (!best || result.score > best.score) best = { ...result, cards: combo };
  }
  return { score: best.score, category: best.category, cards: best.cards, name: describe(best.category, best.tiebreak) };
}

/** 給玩家看的目前牌型；翻牌前只有兩張手牌時也能描述。 */
function describeHand(cards) {
  if (cards.length >= 5) return evaluate(cards).name;
  const groups = groupByRank(cards);
  return groups[0][1] === 2 ? `口袋對 ${rankLabel(groups[0][0])}` : `高牌 ${rankLabel(groups[0][0])}`;
}

module.exports = { evaluate, describeHand, RANKS };
