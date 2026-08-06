import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occursOn, expandOnDate, validateRRule, type CommitmentLike } from '../src/domain/recurrence.js';

// Reference weekdays (UTC): 2026-01-05 is a Monday, 01-06 Tue, 01-07 Wed, 01-09 Fri.
const base = (over: Partial<CommitmentLike> = {}): CommitmentLike => ({
  id: 'c1',
  title: 'X',
  category: 'SCHOOL',
  color: '#889',
  startMin: 600,
  durationMin: 60,
  recurrence: null,
  validFrom: '2026-01-05',
  validUntil: null,
  ...over,
});

test('one-off occurs only on validFrom', () => {
  const c = base();
  assert.equal(occursOn(c, '2026-01-05'), true);
  assert.equal(occursOn(c, '2026-01-06'), false);
});

test('nothing occurs before validFrom', () => {
  assert.equal(occursOn(base({ recurrence: 'FREQ=DAILY' }), '2026-01-04'), false);
});

test('DAILY with INTERVAL', () => {
  const c = base({ recurrence: 'FREQ=DAILY;INTERVAL=3' });
  assert.equal(occursOn(c, '2026-01-05'), true);
  assert.equal(occursOn(c, '2026-01-06'), false);
  assert.equal(occursOn(c, '2026-01-08'), true);
});

test('WEEKLY defaults BYDAY to validFrom weekday', () => {
  const c = base({ recurrence: 'FREQ=WEEKLY' }); // Monday
  assert.equal(occursOn(c, '2026-01-05'), true);
  assert.equal(occursOn(c, '2026-01-06'), false);
  assert.equal(occursOn(c, '2026-01-12'), true); // next Monday
});

test('WEEKLY with BYDAY list', () => {
  const c = base({ recurrence: 'FREQ=WEEKLY;BYDAY=MO,WE,FR' });
  assert.equal(occursOn(c, '2026-01-05'), true); // Mon
  assert.equal(occursOn(c, '2026-01-06'), false); // Tue
  assert.equal(occursOn(c, '2026-01-07'), true); // Wed
  assert.equal(occursOn(c, '2026-01-09'), true); // Fri
});

test('WEEKLY INTERVAL 2 skips alternate weeks', () => {
  const c = base({ recurrence: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO' });
  assert.equal(occursOn(c, '2026-01-05'), true);
  assert.equal(occursOn(c, '2026-01-12'), false);
  assert.equal(occursOn(c, '2026-01-19'), true);
});

test('MONTHLY matches day-of-month', () => {
  const c = base({ validFrom: '2026-01-15', recurrence: 'FREQ=MONTHLY' });
  assert.equal(occursOn(c, '2026-02-15'), true);
  assert.equal(occursOn(c, '2026-02-14'), false);
  assert.equal(occursOn(c, '2026-03-15'), true);
});

test('MONTHLY with INTERVAL 2', () => {
  const c = base({ validFrom: '2026-01-15', recurrence: 'FREQ=MONTHLY;INTERVAL=2' });
  assert.equal(occursOn(c, '2026-02-15'), false);
  assert.equal(occursOn(c, '2026-03-15'), true);
});

test('UNTIL bounds the series', () => {
  const c = base({ recurrence: 'FREQ=DAILY;UNTIL=20260107' });
  assert.equal(occursOn(c, '2026-01-07'), true);
  assert.equal(occursOn(c, '2026-01-08'), false);
});

test('COUNT bounds the number of occurrences', () => {
  const c = base({ recurrence: 'FREQ=DAILY;COUNT=3' }); // 05, 06, 07
  assert.equal(occursOn(c, '2026-01-07'), true);
  assert.equal(occursOn(c, '2026-01-08'), false);
});

test('validUntil overrides regardless of rule', () => {
  const c = base({ recurrence: 'FREQ=DAILY', validUntil: '2026-01-10' });
  assert.equal(occursOn(c, '2026-01-10'), true);
  assert.equal(occursOn(c, '2026-01-11'), false);
});

test('expandOnDate applies CANCELLED exception', () => {
  const c = base({ recurrence: 'FREQ=DAILY' });
  const out = expandOnDate(
    [c],
    [{ commitmentId: 'c1', date: '2026-01-06', type: 'CANCELLED', startMin: null, durationMin: null }],
    '2026-01-06',
  );
  assert.equal(out.length, 0);
});

test('expandOnDate applies MODIFIED override', () => {
  const c = base({ recurrence: 'FREQ=DAILY' });
  const out = expandOnDate(
    [c],
    [{ commitmentId: 'c1', date: '2026-01-06', type: 'MODIFIED', startMin: 720, durationMin: 30 }],
    '2026-01-06',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.startMin, 720);
  assert.equal(out[0]!.durationMin, 30);
});

test('expandOnDate returns instance fields for a plain occurrence', () => {
  const out = expandOnDate([base({ recurrence: 'FREQ=DAILY' })], [], '2026-01-06');
  assert.deepEqual(out, [
    { commitmentId: 'c1', title: 'X', category: 'SCHOOL', color: '#889', startMin: 600, durationMin: 60 },
  ]);
});

test('validateRRule accepts supported subset', () => {
  assert.equal(validateRRule('FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2').ok, true);
  assert.equal(validateRRule('FREQ=DAILY;COUNT=10').ok, true);
  assert.equal(validateRRule('FREQ=MONTHLY;UNTIL=20261231').ok, true);
});

test('validateRRule rejects unsupported and malformed rules', () => {
  assert.equal(validateRRule('FREQ=YEARLY').ok, false);
  assert.equal(validateRRule('BYDAY=MO').ok, false); // missing FREQ
  assert.equal(validateRRule('FREQ=WEEKLY;BYDAY=XX').ok, false);
  assert.equal(validateRRule('FREQ=MONTHLY;BYDAY=MO').ok, false); // BYDAY+MONTHLY unsupported
  assert.equal(validateRRule('FREQ=DAILY;INTERVAL=0').ok, false);
  assert.equal(validateRRule('FREQ=DAILY;UNTIL=2026-12-31').ok, false); // wrong UNTIL format
});
