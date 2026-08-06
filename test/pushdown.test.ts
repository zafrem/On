import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushDown, type PlacedBlock, type FixedInterval } from '../src/domain/pushdown.js';

const b = (id: string, startMin: number, durationMin: number): PlacedBlock => ({ id, startMin, durationMin });
const DAY = { wakeMin: 420, sleepMin: 1380 };

function run(
  dropped: { startMin: number; durationMin: number },
  existing: PlacedBlock[],
  commitments: FixedInterval[] = [],
  day = DAY,
) {
  return pushDown({ dropped, existing, commitments, ...day });
}

test('drop into empty day: nothing moves', () => {
  const r = run({ startMin: 600, durationMin: 30 }, []);
  assert.deepEqual(r, { ok: true, repositions: [], unplaced: [] });
});

test('drop over one block pushes it to the drop end', () => {
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 30)]);
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [{ id: 'A', newStartMin: 630 }]);
  assert.equal(r.unplaced.length, 0);
});

test('adjacent blocks cascade downward', () => {
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 30), b('B', 630, 30)]);
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [
    { id: 'A', newStartMin: 630 },
    { id: 'B', newStartMin: 660 },
  ]);
});

test('a gap stops the chain: distant block is untouched', () => {
  // A pushed to 630-660; B at 700 is past the cursor, so it stays.
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 30), b('B', 700, 30)]);
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [{ id: 'A', newStartMin: 630 }]);
});

test('step 5: a repositioned block collides with a further block and appends it', () => {
  // Drop over A (600-630) -> A to 630-660, which overlaps B (640-670) -> B appended, to 660-690.
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 30), b('B', 640, 30)]);
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [
    { id: 'A', newStartMin: 630 },
    { id: 'B', newStartMin: 660 },
  ]);
});

test('commitment terminates the chain: block spills as PUSHED_OUT', () => {
  // A (600-630) would move to 630-660, overlapping the commitment 630-690 -> unplaced.
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 30)], [{ startMin: 630, durationMin: 60 }]);
  assert.ok(r.ok);
  assert.equal(r.repositions.length, 0);
  assert.deepEqual(r.unplaced, [{ id: 'A', reason: 'PUSHED_OUT', originStartMin: 600, durationMin: 30 }]);
});

test('sleep boundary spills a block as SLEEP_BOUNDARY', () => {
  // sleep at 660; A (600-660) pushed to 630-690 exceeds sleep.
  const r = run({ startMin: 600, durationMin: 30 }, [b('A', 600, 60)], [], { wakeMin: 420, sleepMin: 660 });
  assert.ok(r.ok);
  assert.equal(r.repositions.length, 0);
  assert.deepEqual(r.unplaced, [{ id: 'A', reason: 'SLEEP_BOUNDARY', originStartMin: 600, durationMin: 60 }]);
});

test('terminator spills the block AND everything after it', () => {
  // A(600-630), B(630-660); commitment 660-720. Drop over A: A->630-660, B->660 overlaps commitment.
  // A can move (630-660 is free), B and the rest spill.
  const r = run(
    { startMin: 600, durationMin: 30 },
    [b('A', 600, 30), b('B', 630, 30)],
    [{ startMin: 660, durationMin: 60 }],
  );
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [{ id: 'A', newStartMin: 630 }]);
  assert.deepEqual(r.unplaced.map((u) => u.id), ['B']);
  assert.equal(r.unplaced[0]!.reason, 'PUSHED_OUT');
});

test('R-08: drop ending after sleep is rejected', () => {
  const r = run({ startMin: 1370, durationMin: 30 }, [], [], { wakeMin: 420, sleepMin: 1380 });
  assert.deepEqual(r, { ok: false, reason: 'OUT_OF_DAY' });
});

test('R-08: drop starting before wake is rejected', () => {
  const r = run({ startMin: 400, durationMin: 30 }, [], [], { wakeMin: 420, sleepMin: 1380 });
  assert.deepEqual(r, { ok: false, reason: 'OUT_OF_DAY' });
});

test('drop overlapping a commitment is rejected entirely', () => {
  const r = run({ startMin: 600, durationMin: 30 }, [], [{ startMin: 615, durationMin: 30 }]);
  assert.deepEqual(r, { ok: false, reason: 'COMMITMENT_OVERLAP' });
});

test('block entirely above the drop is not disturbed', () => {
  // C above at 500-530, drop at 600, A at 600.
  const r = run({ startMin: 600, durationMin: 30 }, [b('C', 500, 30), b('A', 600, 30)]);
  assert.ok(r.ok);
  assert.deepEqual(r.repositions, [{ id: 'A', newStartMin: 630 }]);
});
