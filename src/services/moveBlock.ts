/**
 * POST /api/blocks/{id}/move backing service (FR-P05: move & resize).
 *
 * Repositions and/or resizes an existing block, re-running push-down at the new
 * position. Supports moving to another date (FR-U04/FR-I04): the origin day's version
 * is bumped too. Concurrency is checked against the target date's version.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withUser } from '../db/client.js';
import { blocks } from '../db/schema.js';
import type { RejectReason } from '../domain/pushdown.js';
import { applyPlacement } from './placementCore.js';
import { bumpVersion, getVersion } from './shared.js';

export interface MoveBlockInput {
  blockId: string;
  startMin: number;
  durationMin: number;
  date?: string; // defaults to the block's current date
  expectedVersion?: number; // checked against the target date (FR-Y05)
}

export type MoveBlockResult =
  | { status: 'ok'; blockId: string; version: number; movedCount: number; unplacedCount: number }
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'important_limit'; date: string }
  | { status: 'not_found' }
  | { status: 'conflict'; currentVersion: number };

export function moveBlock(userId: string, input: MoveBlockInput): Promise<MoveBlockResult> {
  return withUser(userId, async (tx): Promise<MoveBlockResult> => {
    await tx.execute(sql`set constraints blocks_no_overlap deferred`);

    const block = (
      await tx
        .select({ id: blocks.id, taskId: blocks.taskId, date: blocks.date })
        .from(blocks)
        .where(and(eq(blocks.id, input.blockId), eq(blocks.userId, userId), isNull(blocks.deletedAt)))
        .limit(1)
    )[0];
    if (!block) return { status: 'not_found' };

    const targetDate = input.date ?? block.date;

    const currentVersion = await getVersion(tx, userId, targetDate);
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      return { status: 'conflict', currentVersion };
    }

    const outcome = await applyPlacement(tx, userId, {
      targetDate,
      startMin: input.startMin,
      durationMin: input.durationMin,
      taskId: block.taskId,
      target: { mode: 'move', id: block.id },
    });
    if (outcome.status !== 'ok') return outcome;

    const version = await bumpVersion(tx, userId, targetDate);
    if (targetDate !== block.date) await bumpVersion(tx, userId, block.date); // origin day changed too
    return { ...outcome, version };
  });
}
