/**
 * POST /api/blocks/place backing service (SRS §5.4, §6.4).
 * Places a task as a new block, running push-down in one transaction (R-07).
 */
import { sql } from 'drizzle-orm';
import { withUser } from '../db/client.js';
import type { RejectReason } from '../domain/pushdown.js';
import { applyPlacement } from './placementCore.js';
import { bumpVersion, getVersion } from './shared.js';

export interface PlaceBlockInput {
  taskId: string;
  date: string;
  startMin: number;
  durationMin: number;
  id?: string; // client-supplied UUIDv7 (NFR-11); generated if absent
  expectedVersion?: number; // FR-Y05
}

export type PlaceBlockResult =
  | { status: 'ok'; blockId: string; version: number; movedCount: number; unplacedCount: number }
  | { status: 'rejected'; reason: RejectReason }
  | { status: 'important_limit'; date: string } // R-03 / FR-I03 → client shows swap dialog
  | { status: 'conflict'; currentVersion: number }; // FR-Y06

export function placeBlock(userId: string, input: PlaceBlockInput): Promise<PlaceBlockResult> {
  return withUser(userId, async (tx): Promise<PlaceBlockResult> => {
    await tx.execute(sql`set constraints blocks_no_overlap deferred`);

    const currentVersion = await getVersion(tx, userId, input.date);
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      return { status: 'conflict', currentVersion };
    }

    const outcome = await applyPlacement(tx, userId, {
      targetDate: input.date,
      startMin: input.startMin,
      durationMin: input.durationMin,
      taskId: input.taskId,
      target: { mode: 'insert', id: input.id },
    });
    if (outcome.status !== 'ok') return outcome;

    const version = await bumpVersion(tx, userId, input.date);
    return { ...outcome, version };
  });
}
