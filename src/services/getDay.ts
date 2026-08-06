/**
 * GET /api/days/{date} backing service (SRS §6.4): blocks, expanded commitments,
 * actuals, unplaced items, marker, budget, and the day version in one response.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { withUser } from '../db/client.js';
import { actualEntries, blocks, unplacedItems } from '../db/schema.js';
import { computeBudget, type Budget } from '../domain/budget.js';
import type { CommitmentInstance } from '../domain/recurrence.js';
import { commitmentInstances, ensureMarker, getVersion, type Marker } from './shared.js';

export interface DayView {
  date: string;
  version: number;
  marker: Marker;
  blocks: { id: string; taskId: string; startMin: number; durationMin: number }[];
  commitments: CommitmentInstance[];
  actuals: {
    id: string;
    taskId: string | null;
    commitmentId: string | null;
    label: string;
    startMin: number;
    durationMin: number;
    source: string;
  }[];
  unplaced: {
    id: string;
    taskId: string;
    durationMin: number;
    reason: string;
    originStartMin: number | null;
  }[];
  budget: Budget;
}

export function getDay(userId: string, date: string): Promise<DayView> {
  return withUser(userId, async (tx) => {
    const marker = await ensureMarker(tx, userId, date);
    const commitments = await commitmentInstances(tx, userId, date);

    const blockRows = await tx
      .select({
        id: blocks.id,
        taskId: blocks.taskId,
        startMin: blocks.startMin,
        durationMin: blocks.durationMin,
      })
      .from(blocks)
      .where(and(eq(blocks.userId, userId), eq(blocks.date, date), isNull(blocks.deletedAt)));

    const actualRows = await tx
      .select({
        id: actualEntries.id,
        taskId: actualEntries.taskId,
        commitmentId: actualEntries.commitmentId,
        label: actualEntries.label,
        startMin: actualEntries.startMin,
        durationMin: actualEntries.durationMin,
        source: actualEntries.source,
      })
      .from(actualEntries)
      .where(
        and(eq(actualEntries.userId, userId), eq(actualEntries.date, date), isNull(actualEntries.deletedAt)),
      );

    const unplacedRows = await tx
      .select({
        id: unplacedItems.id,
        taskId: unplacedItems.taskId,
        durationMin: unplacedItems.durationMin,
        reason: unplacedItems.reason,
        originStartMin: unplacedItems.originStartMin,
      })
      .from(unplacedItems)
      .where(and(eq(unplacedItems.userId, userId), eq(unplacedItems.date, date)));

    const budget = computeBudget({
      wakeMin: marker.plannedWakeMin,
      sleepMin: marker.plannedSleepMin,
      commitments,
      blocks: blockRows,
    });

    return {
      date,
      version: await getVersion(tx, userId, date),
      marker,
      blocks: blockRows,
      commitments,
      actuals: actualRows,
      unplaced: unplacedRows,
      budget,
    };
  });
}
