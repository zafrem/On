/**
 * Shared placement apply-logic used by both new placement and move/resize.
 *
 * Runs the push-down algorithm (§5.4) against a target date and applies the result —
 * repositions, unplaced spills, and the dropped block itself (inserted or moved) — all
 * within the caller's transaction (R-07). Enforces R-03 and R-08. The caller owns
 * version/concurrency handling. Assumes the caller has deferred the R-01 constraint.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { blocks, tasks, unplacedItems } from '../db/schema.js';
import { pushDown, type RejectReason } from '../domain/pushdown.js';
import { uuidv7 } from '../lib/uuidv7.js';
import { commitmentInstances, ensureMarker } from './shared.js';

export type DropTarget =
  | { mode: 'insert'; id?: string } // new block from a task
  | { mode: 'move'; id: string }; // reposition/resize an existing block

export interface PlacementSpec {
  targetDate: string;
  startMin: number;
  durationMin: number;
  taskId: string;
  target: DropTarget;
}

export type PlacementOutcome =
  | { status: 'ok'; blockId: string; movedCount: number; unplacedCount: number }
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'important_limit'; date: string };

export async function applyPlacement(
  tx: Tx,
  userId: string,
  spec: PlacementSpec,
): Promise<PlacementOutcome> {
  const marker = await ensureMarker(tx, userId, spec.targetDate);
  const commitments = await commitmentInstances(tx, userId, spec.targetDate);

  // Live plan-lane blocks on the target date, minus the block being moved.
  const liveAll = await tx
    .select({
      id: blocks.id,
      taskId: blocks.taskId,
      startMin: blocks.startMin,
      durationMin: blocks.durationMin,
      kind: tasks.kind,
    })
    .from(blocks)
    .innerJoin(tasks, eq(blocks.taskId, tasks.id))
    .where(and(eq(blocks.userId, userId), eq(blocks.date, spec.targetDate), isNull(blocks.deletedAt)));
  const moveId = spec.target.mode === 'move' ? spec.target.id : undefined;
  const live = liveAll.filter((b) => b.id !== moveId);

  // R-03 / FR-I02 / FR-I04: at most three distinct important tasks placed per day.
  const task = (
    await tx.select({ kind: tasks.kind }).from(tasks).where(eq(tasks.id, spec.taskId)).limit(1)
  )[0];
  if (task?.kind === 'IMPORTANT') {
    const importantTaskIds = new Set(live.filter((b) => b.kind === 'IMPORTANT').map((b) => b.taskId));
    if (!importantTaskIds.has(spec.taskId) && importantTaskIds.size >= 3) {
      return { status: 'important_limit', date: spec.targetDate };
    }
  }

  const result = pushDown({
    dropped: { startMin: spec.startMin, durationMin: spec.durationMin },
    existing: live,
    commitments,
    wakeMin: marker.plannedWakeMin,
    sleepMin: marker.plannedSleepMin,
  });
  if (!result.ok) return { status: 'rejected', reason: result.reason };

  const byId = new Map(live.map((b) => [b.id, b]));

  for (const r of result.repositions) {
    await tx.update(blocks).set({ startMin: r.newStartMin, updatedAt: new Date() }).where(eq(blocks.id, r.id));
  }

  if (result.unplaced.length > 0) {
    const ids = result.unplaced.map((u) => u.id);
    await tx.update(blocks).set({ deletedAt: new Date() }).where(inArray(blocks.id, ids));
    await tx.insert(unplacedItems).values(
      result.unplaced.map((u) => ({
        userId,
        taskId: byId.get(u.id)!.taskId,
        date: spec.targetDate,
        durationMin: u.durationMin,
        reason: u.reason,
        originStartMin: u.originStartMin,
      })),
    );
  }

  let blockId: string;
  if (spec.target.mode === 'insert') {
    blockId = spec.target.id ?? uuidv7();
    await tx.insert(blocks).values({
      id: blockId,
      userId,
      taskId: spec.taskId,
      date: spec.targetDate,
      startMin: spec.startMin,
      durationMin: spec.durationMin,
    });
  } else {
    blockId = spec.target.id;
    await tx
      .update(blocks)
      .set({
        date: spec.targetDate,
        startMin: spec.startMin,
        durationMin: spec.durationMin,
        updatedAt: new Date(),
      })
      .where(eq(blocks.id, blockId));
  }

  return { status: 'ok', blockId, movedCount: result.repositions.length, unplacedCount: result.unplaced.length };
}
