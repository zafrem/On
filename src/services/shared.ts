/** Shared query helpers for day-scoped services. All run inside a withUser tx. */
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  commitmentExceptions,
  commitments,
  dayMarkers,
  profiles,
} from '../db/schema.js';
import { expandOnDate, type CommitmentInstance } from '../domain/recurrence.js';

export interface Marker {
  plannedWakeMin: number;
  plannedSleepMin: number;
  actualWakeMin: number | null;
  actualSleepMin: number | null;
}

/** Fetch the date's marker, lazily materializing it from profile defaults (FR-D02). */
export async function ensureMarker(tx: Tx, userId: string, date: string): Promise<Marker> {
  const existing = await tx
    .select()
    .from(dayMarkers)
    .where(and(eq(dayMarkers.userId, userId), eq(dayMarkers.date, date)))
    .limit(1);
  if (existing[0]) return existing[0];

  const prof = await tx.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!prof[0]) throw new Error(`No profile for user ${userId}`);
  const [inserted] = await tx
    .insert(dayMarkers)
    .values({
      userId,
      date,
      plannedWakeMin: prof[0].defaultWakeMin,
      plannedSleepMin: prof[0].defaultSleepMin,
    })
    .returning();
  return inserted!;
}

/** Commitment instances occurring on the date, after exceptions (§3.3). */
export async function commitmentInstances(
  tx: Tx,
  userId: string,
  date: string,
): Promise<CommitmentInstance[]> {
  const rows = await tx
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.userId, userId),
        isNull(commitments.deletedAt),
        lte(commitments.validFrom, date),
        or(isNull(commitments.validUntil), gte(commitments.validUntil, date)),
      ),
    );
  const exceptions = await tx
    .select()
    .from(commitmentExceptions)
    .where(and(eq(commitmentExceptions.userId, userId), eq(commitmentExceptions.date, date)));
  return expandOnDate(rows, exceptions, date);
}

/** Wall-clock date ('YYYY-MM-DD') and minute-of-day for an instant in a timezone. */
function wallClock(instant: Date, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const addDays = (date: string, delta: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/**
 * Attribute an instant to a day and minute-of-day using the wake→sleep window (§3.5,
 * Q-04). An early-morning instant that falls inside the previous day's post-midnight
 * tail (sleep stored as 1440+) is attributed to that previous day with startMin >= 1440.
 */
export async function attributeInstant(
  tx: Tx,
  userId: string,
  instant: Date,
): Promise<{ date: string; startMin: number }> {
  const prof = await tx.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!prof[0]) throw new Error(`No profile for user ${userId}`);
  const { date, minutes } = wallClock(instant, prof[0].timezone);

  const prevDate = addDays(date, -1);
  const prev = await tx
    .select()
    .from(dayMarkers)
    .where(and(eq(dayMarkers.userId, userId), eq(dayMarkers.date, prevDate)))
    .limit(1);
  if (prev[0] && prev[0].plannedSleepMin > 1440) {
    const shifted = minutes + 1440;
    if (shifted >= prev[0].plannedWakeMin && shifted < prev[0].plannedSleepMin) {
      return { date: prevDate, startMin: shifted };
    }
  }
  return { date, startMin: minutes };
}

/** Current day version, 0 when the day has never been touched (FR-Y08). */
export async function getVersion(tx: Tx, userId: string, date: string): Promise<number> {
  const res = await tx.execute(
    sql`select version from day_versions where user_id = ${userId} and date = ${date}`,
  );
  const row = res.rows[0] as { version: number } | undefined;
  return row ? Number(row.version) : 0;
}

/** Atomically increment (or initialize) the day version, returning the new value. */
export async function bumpVersion(tx: Tx, userId: string, date: string): Promise<number> {
  const res = await tx.execute(sql`
    insert into day_versions (user_id, date, version)
    values (${userId}, ${date}, 1)
    on conflict (user_id, date)
    do update set version = day_versions.version + 1, updated_at = now()
    returning version
  `);
  return Number((res.rows[0] as { version: number }).version);
}
