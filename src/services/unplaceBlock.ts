/**
 * DELETE /api/blocks/{id} backing service — unplace to the unplaced zone (R-05, FR-U01).
 *
 * A block that leaves the plan lane is never destroyed: it is soft-deleted and recorded
 * as an UnplacedItem (reason MANUAL). Removing a block cannot create an overlap, so no
 * push-down is needed. The day version is bumped.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withUser } from '../db/client.js';
import { blocks, unplacedItems } from '../db/schema.js';
import { bumpVersion, getVersion } from './shared.js';

export interface UnplaceBlockInput {
  blockId: string;
  expectedVersion?: number;
}

export type UnplaceBlockResult =
  | { status: 'ok'; version: number }
  | { status: 'not_found' }
  | { status: 'conflict'; currentVersion: number };

export function unplaceBlock(userId: string, input: UnplaceBlockInput): Promise<UnplaceBlockResult> {
  return withUser(userId, async (tx): Promise<UnplaceBlockResult> => {
    const block = (
      await tx
        .select({
          id: blocks.id,
          taskId: blocks.taskId,
          date: blocks.date,
          startMin: blocks.startMin,
          durationMin: blocks.durationMin,
        })
        .from(blocks)
        .where(and(eq(blocks.id, input.blockId), eq(blocks.userId, userId), isNull(blocks.deletedAt)))
        .limit(1)
    )[0];
    if (!block) return { status: 'not_found' };

    const currentVersion = await getVersion(tx, userId, block.date);
    if (input.expectedVersion != null && input.expectedVersion !== currentVersion) {
      return { status: 'conflict', currentVersion };
    }

    await tx.update(blocks).set({ deletedAt: new Date() }).where(eq(blocks.id, block.id));
    await tx.insert(unplacedItems).values({
      userId,
      taskId: block.taskId,
      date: block.date,
      durationMin: block.durationMin,
      reason: 'MANUAL',
      originStartMin: block.startMin,
    });

    const version = await bumpVersion(tx, userId, block.date);
    return { status: 'ok', version };
  });
}
