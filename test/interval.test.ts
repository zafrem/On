import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, unionLength } from '../src/domain/interval.js';

test('overlaps: touching endpoints do not overlap', () => {
  assert.equal(overlaps(600, 630, 630, 660), false);
  assert.equal(overlaps(600, 630, 629, 660), true);
  assert.equal(overlaps(630, 660, 600, 630), false);
});

test('unionLength: empty is zero', () => {
  assert.equal(unionLength([]), 0);
});

test('unionLength: disjoint intervals sum', () => {
  assert.equal(unionLength([{ start: 0, end: 30 }, { start: 60, end: 90 }]), 60);
});

test('unionLength: overlapping intervals count once', () => {
  assert.equal(unionLength([{ start: 600, end: 660 }, { start: 630, end: 690 }]), 90);
});

test('unionLength: nested interval absorbed', () => {
  assert.equal(unionLength([{ start: 0, end: 120 }, { start: 30, end: 60 }]), 120);
});

test('unionLength: adjacent (touching) intervals merge', () => {
  assert.equal(unionLength([{ start: 0, end: 30 }, { start: 30, end: 60 }]), 60);
});
