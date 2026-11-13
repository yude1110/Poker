'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, describeHand } = require('../server/evaluator');

const hand = (text) => text.split(' ');
const score = (text) => evaluate(hand(text)).score;
const category = (text) => evaluate(hand(text)).category;

test('辨識所有牌型', () => {
  assert.equal(category('As Ks Qs Js Ts 2d 3c'), 9);
  assert.equal(category('9h 8h 7h 6h 5h Ad Kc'), 8);
  assert.equal(category('Ah Ad Ac As 2d 3c 4h'), 7);
  assert.equal(category('Kh Kd Kc 7s 7d 2c 3h'), 6);
  assert.equal(category('Ah Th 7h 4h 2h Kd Qc'), 5);
  assert.equal(category('9h 8d 7c 6s 5h Ad Kc'), 4);
  assert.equal(category('Qh Qd Qc 7s 5d 2c 3h'), 3);
  assert.equal(category('Qh Qd 7c 7s 5d 2c 3h'), 2);
  assert.equal(category('Qh Qd 8c 7s 5d 2c 3h'), 1);
  assert.equal(category('Ah Qd 9c 7s 5d 3c 2h'), 0);
});

test('A2345 是最小的順子，A 高同花順是皇家', () => {
  const wheel = evaluate(hand('Ah 2d 3c 4s 5h Kd 9c'));
  assert.equal(wheel.category, 4);
  assert.equal(wheel.name, '順子 到 5');
  assert.ok(score('2h 3d 4c 5s 6h Kd 9c') > wheel.score);
  assert.equal(evaluate(hand('Ah 2h 3h 4h 5h Kd 9c')).category, 8);
});

test('踢腳牌決定勝負，第六張以後不算', () => {
  assert.ok(score('Ah Ad Kc 7s 5d 3c 2h') > score('As Ac Qc 7d 5h 3s 2d'));
  // 牌面已有順子，兩人的底牌都沒用到：平手
  assert.equal(score('Ah Kd 5c 6s 7h 8d 9c'), score('Ac Qd 5h 6d 7s 8c 9h'));
  // 三對取最大的兩對，踢腳取剩下最大的一張
  assert.equal(score('Ah Ad Kc Ks 2d 2c 3h'), score('As Ac Kh Kd 3c 3s 2h'));
});

test('葫蘆：兩組三條時取大的當三條', () => {
  const result = evaluate(hand('Kh Kd Kc 7s 7d 7c 3h'));
  assert.equal(result.category, 6);
  assert.equal(result.name, '葫蘆 K 帶 7');
});

test('最佳 5 張不會超過 5 張且都來自手中', () => {
  const cards = hand('As Ks Qs Js Ts 2d 3c');
  const result = evaluate(cards);
  assert.equal(result.cards.length, 5);
  assert.ok(result.cards.every((c) => cards.includes(c)));
  assert.equal(result.name, '皇家同花順');
});

test('翻牌前也能描述手牌', () => {
  assert.equal(describeHand(['Ah', 'Ad']), '口袋對 A');
  assert.equal(describeHand(['Kh', '7d']), '高牌 K');
  assert.equal(describeHand(['Ah', 'Ad', 'Ac', '7s', '2d']), '三條 A');
});
