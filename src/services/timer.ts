/**
 * Timer control (SRS §5.6, §6.4): the single server-side ActiveTimer is the only way to
 * enforce one timer per user across devices (FR-A03). Endpoints: start, stop, read.
 *
 *  - R-09: a timer only starts on explicit user action (this service is that action).
 *  - FR-A03: starting a timer auto-commits any timer already running.
 *  - FR-A04: no pause. Stop ends the entry; start creates a new one.
 *  - FR-A05: on stop, duration rounds to the nearest 5 minutes; under 5 → discard.
 *  - §3.5: the actual entry's date is attributed by the wake→sleep window.
 */
import { eq } from 'drizzle-orm';
import { withUser, type Tx } from '../db/client.js';
import { actualEntries, activeTimers } from '../db/schema.js';
import { uuidv7 } from '../lib/uuidv7.js';
import { attributeInstant, bumpVersion } from './shared.js';

export interface StartTimerInput {
  deviceId: string;
  taskId?: string;
  commitmentId?: string;
  label?: string;
  expectedEndAt?: string; // ISO; used for notification scheduling (FR-R15)
}

export interface ActiveTimerView {
  taskId: string | null;
  commitmentId: string | null;
  label: string;
  startedAt: string;
  expectedEndAt: string | null;
  deviceId: string;
}

export interface CommittedEntry {
  entryId: string;
  date: string;
  startMin: number;
  durationMin: number;
}

export type StartTimerResult =
  | { status: 'ok'; timer: ActiveTimerView; autoCommitted: CommittedEntry | null }
  | { status: 'label_required' };

export type StopTimerResult =
  | { status: 'ok'; entry: CommittedEntry }
  | { status: 'too_short'; elapsedSec: number } // FR-A05: under 5 min, nothing stored
  | { status: 'no_timer' };

/**
 * Commit the running timer (if any) into an ActualEntry. Returns the entry, or null when
 * there was no timer, or 'too_short' when the rounded duration is under 5 minutes (the DB
 * floor). In every non-null case the ActiveTimer row is cleared.
 */
async function commitTimer(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<CommittedEntry | 'too_short' | null> {
  const active = (await tx.select().from(activeTimers).where(eq(activeTimers.userId, userId)).limit(1))[0];
  if (!active) return null;

  const elapsedMin = (now.getTime() - active.startedAt.getTime()) / 60_000;
  const durationMin = Math.round(elapsedMin / 5) * 5;
  await tx.delete(activeTimers).where(eq(activeTimers.userId, userId));

  if (durationMin < 5) return 'too_short';

  const { date, startMin } = await attributeInstant(tx, userId, active.startedAt);
  const entryId = uuidv7();
  await tx.insert(actualEntries).values({
    id: entryId,
    userId,
    taskId: active.taskId,
    commitmentId: active.commitmentId,
    label: active.label,
    date,
    startMin,
    durationMin,
    source: 'TIMER',
  });
  await bumpVersion(tx, userId, date);
  return { entryId, date, startMin, durationMin };
}

export function startTimer(userId: string, input: StartTimerInput): Promise<StartTimerResult> {
  return withUser(userId, async (tx): Promise<StartTimerResult> => {
    const label = input.label ?? '';
    if (!input.taskId && !input.commitmentId && label.trim() === '') {
      return { status: 'label_required' };
    }

    const now = new Date();
    const prior = await commitTimer(tx, userId, now); // FR-A03: auto-commit existing

    const expectedEndAt = input.expectedEndAt ? new Date(input.expectedEndAt) : null;
    await tx
      .insert(activeTimers)
      .values({
        userId,
        taskId: input.taskId ?? null,
        commitmentId: input.commitmentId ?? null,
        label,
        startedAt: now,
        expectedEndAt,
        deviceId: input.deviceId,
      })
      .onConflictDoUpdate({
        target: activeTimers.userId,
        set: {
          taskId: input.taskId ?? null,
          commitmentId: input.commitmentId ?? null,
          label,
          startedAt: now,
          expectedEndAt,
          deviceId: input.deviceId,
        },
      });

    return {
      status: 'ok',
      timer: {
        taskId: input.taskId ?? null,
        commitmentId: input.commitmentId ?? null,
        label,
        startedAt: now.toISOString(),
        expectedEndAt: expectedEndAt ? expectedEndAt.toISOString() : null,
        deviceId: input.deviceId,
      },
      autoCommitted: prior && prior !== 'too_short' ? prior : null,
    };
  });
}

export function stopTimer(userId: string): Promise<StopTimerResult> {
  return withUser(userId, async (tx): Promise<StopTimerResult> => {
    const now = new Date();
    const active = (await tx.select().from(activeTimers).where(eq(activeTimers.userId, userId)).limit(1))[0];
    if (!active) return { status: 'no_timer' };

    const result = await commitTimer(tx, userId, now);
    if (result === 'too_short' || result === null) {
      return { status: 'too_short', elapsedSec: Math.round((now.getTime() - active.startedAt.getTime()) / 1000) };
    }
    return { status: 'ok', entry: result };
  });
}

export function getTimer(userId: string): Promise<ActiveTimerView | null> {
  return withUser(userId, async (tx) => {
    const active = (await tx.select().from(activeTimers).where(eq(activeTimers.userId, userId)).limit(1))[0];
    if (!active) return null;
    return {
      taskId: active.taskId,
      commitmentId: active.commitmentId,
      label: active.label,
      startedAt: active.startedAt.toISOString(),
      expectedEndAt: active.expectedEndAt ? active.expectedEndAt.toISOString() : null,
      deviceId: active.deviceId,
    };
  });
}
