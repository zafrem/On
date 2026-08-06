import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBudget } from '../src/domain/budget.js';

test('basic budget arithmetic', () => {
  const budget = computeBudget({
    wakeMin: 420,
    sleepMin: 1380, // 960-min day
    commitments: [{ startMin: 600, durationMin: 60 }],
    blocks: [{ durationMin: 30 }, { durationMin: 45 }],
  });
  assert.equal(budget.daySpan, 960);
  assert.equal(budget.committed, 60);
  assert.equal(budget.available, 900);
  assert.equal(budget.placed, 75);
  assert.equal(budget.remaining, 825);
});

test('overlapping commitments are counted once (union, not sum)', () => {
  const budget = computeBudget({
    wakeMin: 420,
    sleepMin: 1380,
    commitments: [
      { startMin: 600, durationMin: 60 }, // 600-660
      { startMin: 630, durationMin: 60 }, // 630-690  → union 600-690 = 90
    ],
    blocks: [],
  });
  assert.equal(budget.committed, 90);
  assert.equal(budget.available, 870);
});

test('overloaded when remaining below 10% of the day span', () => {
  // day span 100, threshold 10. remaining 5 -> overloaded.
  const budget = computeBudget({
    wakeMin: 0,
    sleepMin: 100,
    commitments: [],
    blocks: [{ durationMin: 95 }],
  });
  assert.equal(budget.remaining, 5);
  assert.equal(budget.overloaded, true);
});

test('not overloaded at exactly 10%', () => {
  const budget = computeBudget({ wakeMin: 0, sleepMin: 100, commitments: [], blocks: [{ durationMin: 90 }] });
  assert.equal(budget.remaining, 10);
  assert.equal(budget.overloaded, false);
});
