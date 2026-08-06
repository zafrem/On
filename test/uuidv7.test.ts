import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '../src/lib/uuidv7.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('produces a well-formed v7 UUID (version + variant nibbles)', () => {
  for (let i = 0; i < 100; i++) assert.match(uuidv7(), UUID_RE);
});

test('ids are unique', () => {
  const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
  assert.equal(set.size, 1000);
});

test('embeds the current time in the 48-bit big-endian prefix', () => {
  const now = Date.now();
  const id = uuidv7();
  const tsHex = id.slice(0, 8) + id.slice(9, 13); // first 12 hex chars = 48-bit ms
  const ts = Number.parseInt(tsHex, 16);
  assert.ok(Math.abs(ts - now) < 1000, `embedded ts ${ts} within 1s of ${now}`);
});
