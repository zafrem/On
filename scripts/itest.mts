/**
 * Integration test against the real Neon DB. Creates a throwaway user, exercises
 * placeBlock (push-down, R-03, R-08) and getDay, asserts, then deletes the user
 * (cascades clean up everything). Run: DATABASE_URL="$ON_NEON_DB" npx tsx scripts/itest.mts
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { pool, withUser } from '../src/db/client.js';
import { activeTimers, commitments, dayMarkers, profiles, tasks, users } from '../src/db/schema.js';
import { uuidv7 } from '../src/lib/uuidv7.js';
import { placeBlock } from '../src/services/placeBlock.js';
import { moveBlock } from '../src/services/moveBlock.js';
import { unplaceBlock } from '../src/services/unplaceBlock.js';
import { getDay } from '../src/services/getDay.js';
import { getTimer, startTimer, stopTimer } from '../src/services/timer.js';
import { createTask, deleteTask, listTasks, updateTask } from '../src/services/tasks.js';
import {
  bulkCreateCommitments,
  cancelInstance,
  createCommitment,
  deleteCommitment,
  listCommitments,
  rescheduleInstance,
  updateCommitment,
} from '../src/services/commitments.js';

const DATE = '2026-09-01'; // a Tuesday
let failures = 0;
function assert(cond: boolean, msg: string) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures++;
}

const userId = uuidv7();

async function seed() {
  await withUser(userId, async (tx) => {
    await tx.insert(users).values({ id: userId, email: `itest-${userId}@x.dev` });
    await tx
      .insert(profiles)
      .values({ userId, timezone: 'Asia/Seoul', defaultWakeMin: 420, defaultSleepMin: 1380 }); // 07:00–23:00
  });
}

async function mkTask(title: string, kind: 'NORMAL' | 'IMPORTANT' | 'SLACK', est = 30) {
  const id = uuidv7();
  await withUser(userId, async (tx) => {
    await tx.insert(tasks).values({ id, userId, title, kind, estimateMin: est });
  });
  return id;
}

async function main() {
  await seed();

  // --- push-down: two blocks, drop a third over the first pushes the chain down ---
  const a = await mkTask('A', 'NORMAL');
  const b = await mkTask('B', 'NORMAL');
  const c = await mkTask('C', 'NORMAL');

  const rA = await placeBlock(userId, { taskId: a, date: DATE, startMin: 600, durationMin: 30 }); // 10:00
  const rB = await placeBlock(userId, { taskId: b, date: DATE, startMin: 630, durationMin: 30 }); // 10:30
  assert(rA.status === 'ok' && rB.status === 'ok', 'placed two adjacent blocks');
  assert(rB.status === 'ok' && rB.version === 2, 'day version incremented to 2');

  // Drop C at 10:00 (over A). A→10:30, B→11:00. movedCount = 2.
  const rC = await placeBlock(userId, { taskId: c, date: DATE, startMin: 600, durationMin: 30 });
  assert(rC.status === 'ok' && rC.movedCount === 2 && rC.unplacedCount === 0, 'push-down moved 2, unplaced 0');

  let day = await getDay(userId, DATE);
  const starts = day.blocks.map((x) => x.startMin).sort((m, n) => m - n);
  assert(JSON.stringify(starts) === JSON.stringify([600, 630, 660]), 'blocks now at 600/630/660 (C,A,B)');

  // --- R-08: drop after sleep is rejected ---
  const d = await mkTask('D', 'NORMAL');
  const rD = await placeBlock(userId, { taskId: d, date: DATE, startMin: 1370, durationMin: 30 }); // ends 1400 > 1380
  assert(rD.status === 'rejected' && rD.reason === 'OUT_OF_DAY', 'R-08: block past sleep rejected');

  // --- commitment terminator: a commitment blocks push-down → PUSHED_OUT ---
  await withUser(userId, async (tx) => {
    await tx.insert(commitments).values({
      userId,
      title: 'Class',
      category: 'SCHOOL',
      startMin: 690, // 11:30
      durationMin: 60,
      color: '#889',
      validFrom: DATE,
    });
  });
  // Drop E at 660 (over B at 660). B would move to 690 → overlaps the commitment → unplaced.
  const e = await mkTask('E', 'NORMAL');
  const rE = await placeBlock(userId, { taskId: e, date: DATE, startMin: 660, durationMin: 30 });
  assert(rE.status === 'ok' && rE.unplacedCount === 1, 'commitment terminator pushed 1 block to unplaced');
  day = await getDay(userId, DATE);
  assert(day.unplaced.some((u) => u.reason === 'PUSHED_OUT'), 'unplaced item has reason PUSHED_OUT');

  // --- budget: committed counts the 60-min commitment once ---
  assert(day.budget.committed === 60, `committed = 60 (got ${day.budget.committed})`);
  assert(day.budget.daySpan === 960, `daySpan = 960 (got ${day.budget.daySpan})`);

  // --- R-03: a 4th distinct important task on the day is blocked ---
  const imp: string[] = [];
  for (const t of ['I1', 'I2', 'I3', 'I4']) imp.push(await mkTask(t, 'IMPORTANT'));
  const slots = [180, 210, 240, 270].map((_, i) => 420 + i * 40); // spaced, within day, no overlap
  const res = [];
  for (let i = 0; i < 4; i++) {
    res.push(await placeBlock(userId, { taskId: imp[i]!, date: DATE, startMin: slots[i]!, durationMin: 30 }));
  }
  assert(res.slice(0, 3).every((r) => r.status === 'ok'), 'three important tasks placed');
  assert(res[3]!.status === 'important_limit', 'R-03: fourth important task blocked');

  // --- FR-Y06: stale expectedVersion → conflict ---
  const f = await mkTask('F', 'NORMAL');
  const stale = await placeBlock(userId, { taskId: f, date: DATE, startMin: 900, durationMin: 30, expectedVersion: 1 });
  assert(stale.status === 'conflict', 'stale expectedVersion returns conflict');

  // --- move / resize / unplace on a fresh date ---
  const DATE2 = '2026-09-02';
  const g = await mkTask('G', 'NORMAL');
  const rG = await placeBlock(userId, { taskId: g, date: DATE2, startMin: 600, durationMin: 30 });
  assert(rG.status === 'ok', 'placed G on DATE2');
  const gId = rG.status === 'ok' ? rG.blockId : '';

  const mv = await moveBlock(userId, { blockId: gId, startMin: 700, durationMin: 30 });
  assert(mv.status === 'ok', 'moved G to 700');
  let d2 = await getDay(userId, DATE2);
  assert(d2.blocks.find((x) => x.id === gId)?.startMin === 700, 'G now at 700');

  const rz = await moveBlock(userId, { blockId: gId, startMin: 700, durationMin: 60 });
  assert(rz.status === 'ok', 'resized G to 60 min');
  d2 = await getDay(userId, DATE2);
  assert(d2.blocks.find((x) => x.id === gId)?.durationMin === 60, 'G duration now 60');

  const up = await unplaceBlock(userId, { blockId: gId });
  assert(up.status === 'ok', 'unplaced G');
  d2 = await getDay(userId, DATE2);
  assert(!d2.blocks.some((x) => x.id === gId), 'G no longer on the plan lane');
  assert(d2.unplaced.some((u) => u.reason === 'MANUAL'), 'G recorded in unplaced zone (MANUAL)');

  const nf = await moveBlock(userId, { blockId: uuidv7(), startMin: 600, durationMin: 30 });
  assert(nf.status === 'not_found', 'moving a nonexistent block returns not_found');

  // --- timer lifecycle ---
  assert((await getTimer(userId)) === null, 'no active timer initially');
  const st = await startTimer(userId, { deviceId: 'd1', label: 'Reading' });
  assert(st.status === 'ok', 'started ad-hoc timer');
  assert((await getTimer(userId)) !== null, 'timer now active');

  const tooShort = await stopTimer(userId);
  assert(tooShort.status === 'too_short', 'immediate stop is too_short (FR-A05)');
  assert((await getTimer(userId)) === null, 'timer cleared after stop');

  const t1 = await mkTask('Timed', 'NORMAL');
  await startTimer(userId, { deviceId: 'd1', taskId: t1 });
  await backdateTimer(30);
  const stopped = await stopTimer(userId);
  assert(stopped.status === 'ok' && stopped.entry.durationMin === 30, 'stop commits a 30-min entry');

  await startTimer(userId, { deviceId: 'd1', label: 'First' });
  await backdateTimer(20);
  const second = await startTimer(userId, { deviceId: 'd1', label: 'Second' });
  assert(
    second.status === 'ok' && second.autoCommitted?.durationMin === 20,
    'starting a new timer auto-commits the prior (20 min, FR-A03)',
  );
  await stopTimer(userId); // clear the just-started 'Second'

  const noLabel = await startTimer(userId, { deviceId: 'd1' });
  assert(noLabel.status === 'label_required', 'ad-hoc timer without label rejected');
  assert((await stopTimer(userId)).status === 'no_timer', 'stop with no timer');

  // --- §3.5 attribution: a post-midnight timer lands on the previous wake→sleep day ---
  const startedAt = new Date('2026-07-31T15:30:00Z'); // = 2026-08-01 00:30 in Asia/Seoul
  await withUser(userId, async (tx) => {
    await tx
      .insert(dayMarkers)
      .values({ userId, date: '2026-07-31', plannedWakeMin: 420, plannedSleepMin: 1500 }); // sleeps 01:00
    await tx
      .insert(activeTimers)
      .values({ userId, label: 'Night', startedAt, deviceId: 'd1' })
      .onConflictDoUpdate({
        target: activeTimers.userId,
        set: { label: 'Night', startedAt, taskId: null, commitmentId: null, expectedEndAt: null, deviceId: 'd1' },
      });
  });
  const night = await stopTimer(userId);
  assert(
    night.status === 'ok' && night.entry.date === '2026-07-31' && night.entry.startMin === 1470,
    'post-midnight timer attributed to previous day (2026-07-31, startMin 1470)',
  );

  // --- task hierarchy / container-leaf / important rules ---
  const DATE4 = '2026-09-03';
  const P = await createTask(userId, { title: 'Big', estimateMin: 30 });
  const pId = P.status === 'ok' ? P.id : '';
  assert(P.status === 'ok', 'created root leaf task');
  await placeBlock(userId, { taskId: pId, date: DATE4, startMin: 600, durationMin: 30 });

  assert((await createTask(userId, { title: 'bad', estimateMin: 32 })).status === 'estimate_invalid', 'estimate not in 5s rejected');

  const child1 = await createTask(userId, { title: 'C1', parentId: pId, estimateMin: 15 });
  assert(child1.status === 'ok' && child1.parentConverted, 'first child converts parent to container');
  const c1Id = child1.status === 'ok' ? child1.id : '';

  let d4 = await getDay(userId, DATE4);
  assert(!d4.blocks.some((b) => b.taskId === pId), 'container conversion removed parent block from plan lane');
  assert(d4.unplaced.some((u) => u.reason === 'CONTAINER_CONVERSION'), 'parent block recorded CONTAINER_CONVERSION');

  assert((await createTask(userId, { title: 'GC', parentId: c1Id, estimateMin: 10 })).status === 'max_depth', 'grandchild rejected (max depth 2)');
  assert((await updateTask(userId, { id: pId, kind: 'IMPORTANT' })).status === 'kind_leaf_only', 'IMPORTANT on container rejected');
  assert((await updateTask(userId, { id: pId, estimateMin: 30 })).status === 'estimate_container', 'estimate on container rejected');

  await updateTask(userId, { id: c1Id, status: 'DONE' });
  const pv = (await listTasks(userId)).find((t) => t.id === pId);
  assert(pv?.isContainer === true && pv.progress === 1, 'container progress = 1 when its only child is done');

  const del = await deleteTask(userId, c1Id);
  assert(del.status === 'ok' && del.parentNeedsEstimate === pId, 'deleting last child reverts parent to a leaf');

  const Z = await createTask(userId, { title: 'Z', estimateMin: 30 });
  const zId = Z.status === 'ok' ? Z.id : '';
  await placeBlock(userId, { taskId: zId, date: DATE, startMin: 900, durationMin: 30 });
  const conf = await updateTask(userId, { id: zId, kind: 'IMPORTANT' });
  assert(conf.status === 'important_conflict' && conf.dates.includes(DATE), 'switch to IMPORTANT blocked by 3-per-day, reports date');

  // --- commitments CRUD + exceptions ---
  const okc = await createCommitment(userId, {
    title: 'Gym', category: 'EXERCISE', startMin: 480, durationMin: 60, recurrence: 'FREQ=DAILY', validFrom: DATE4, color: '#abc',
  });
  const cid = okc.status === 'ok' ? okc.id : '';
  assert(okc.status === 'ok', 'created recurring commitment');

  const badc = await createCommitment(userId, {
    title: 'x', startMin: 480, durationMin: 60, recurrence: 'FREQ=YEARLY', validFrom: DATE4, color: '#abc',
  });
  assert(badc.status === 'invalid' && badc.field === 'recurrence', 'unsupported RRULE rejected on create');

  const bulk = await bulkCreateCommitments(userId, [
    { title: 'a', startMin: 300, durationMin: 30, validFrom: DATE4, color: '#a' },
    { title: 'b', startMin: 360, durationMin: 30, validFrom: DATE4, color: '#b' },
  ]);
  assert(bulk.status === 'ok' && bulk.ids.length === 2, 'bulk grid entry created 2 commitments');

  d4 = await getDay(userId, DATE4);
  assert(d4.commitments.some((c) => c.commitmentId === cid), 'daily commitment expands onto DATE4');

  assert((await cancelInstance(userId, cid, DATE4)).status === 'ok', 'cancel instance ok');
  d4 = await getDay(userId, DATE4);
  assert(!d4.commitments.some((c) => c.commitmentId === cid), 'cancelled instance removed from DATE4');

  const DATE5 = '2026-09-04';
  assert((await rescheduleInstance(userId, cid, DATE5, 500, 30)).status === 'ok', 'reschedule instance ok');
  const inst = (await getDay(userId, DATE5)).commitments.find((c) => c.commitmentId === cid);
  assert(inst?.startMin === 500 && inst.durationMin === 30, 'rescheduled instance overrides time on DATE5');

  assert((await listCommitments(userId, { category: 'EXERCISE' })).some((c) => c.id === cid), 'list filters by category');
  assert((await updateCommitment(userId, cid, { durationMin: 90 })).status === 'ok', 'update commitment ok');
  assert((await deleteCommitment(userId, cid)).status === 'ok', 'delete commitment ok');
}

async function backdateTimer(minutes: number) {
  await withUser(userId, async (tx) => {
    await tx
      .update(activeTimers)
      .set({ startedAt: new Date(Date.now() - minutes * 60_000) })
      .where(eq(activeTimers.userId, userId));
  });
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    // Cleanup: delete the user; FK cascades remove all rows.
    await withUser(userId, async (tx) => {
      await tx.delete(users).where(and(eq(users.id, userId)));
    });
    await pool.end();
    console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
