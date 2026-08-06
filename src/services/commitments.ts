/**
 * Commitment CRUD (SRS §3.3, §5.3). Commitments are exempt from the 60-minute cap and
 * priority limits. Recurrence uses the supported RRULE subset (validated on write). The
 * weekly grid (FR-C12) is served by bulkCreate. Individual instances are cancelled or
 * rescheduled via CommitmentException (this-date-only; "this and following" is Q-08).
 */
import { and, eq, gte, isNull, lte, or, type SQL } from 'drizzle-orm';
import { withUser, type Tx } from '../db/client.js';
import { commitmentExceptions, commitments } from '../db/schema.js';
import { validateRRule } from '../domain/recurrence.js';
import { uuidv7 } from '../lib/uuidv7.js';

type Category = 'SCHOOL' | 'ACADEMY' | 'EXERCISE' | 'WORK' | 'APPOINTMENT' | 'OTHER';

export interface CommitmentInput {
  id?: string;
  title: string;
  category?: Category;
  location?: string;
  startMin: number;
  durationMin: number;
  recurrence?: string;
  validFrom: string;
  validUntil?: string;
  remainingCount?: number;
  color: string;
}

type ValidationError = { field: string; error: string };

function validate(input: CommitmentInput): ValidationError | null {
  if (input.title.trim() === '') return { field: 'title', error: 'required' };
  if (input.color.trim() === '') return { field: 'color', error: 'required' };
  if (!(input.startMin >= 0) || input.startMin % 5 !== 0)
    return { field: 'startMin', error: 'must be >= 0 and a multiple of 5' };
  if (!(input.durationMin >= 5)) return { field: 'durationMin', error: 'must be >= 5' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) return { field: 'validFrom', error: 'YYYY-MM-DD' };
  if (input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil))
    return { field: 'validUntil', error: 'YYYY-MM-DD' };
  if (input.recurrence) {
    const r = validateRRule(input.recurrence);
    if (!r.ok) return { field: 'recurrence', error: r.error };
  }
  return null;
}

function values(userId: string, input: CommitmentInput, id: string) {
  return {
    id,
    userId,
    title: input.title,
    category: input.category ?? ('OTHER' as Category),
    location: input.location ?? null,
    startMin: input.startMin,
    durationMin: input.durationMin,
    recurrence: input.recurrence ?? null,
    validFrom: input.validFrom,
    validUntil: input.validUntil ?? null,
    remainingCount: input.remainingCount ?? null,
    color: input.color,
  };
}

export type CreateCommitmentResult =
  | { status: 'ok'; id: string }
  | { status: 'invalid'; field: string; error: string };

export function createCommitment(userId: string, input: CommitmentInput): Promise<CreateCommitmentResult> {
  return withUser(userId, async (tx): Promise<CreateCommitmentResult> => {
    const err = validate(input);
    if (err) return { status: 'invalid', ...err };
    const id = input.id ?? uuidv7();
    await tx.insert(commitments).values(values(userId, input, id));
    return { status: 'ok', id };
  });
}

export type BulkCreateResult =
  | { status: 'ok'; ids: string[] }
  | { status: 'invalid'; index: number; field: string; error: string };

/** Bulk insert for the weekly grid editor (FR-C03). All-or-nothing within the transaction. */
export function bulkCreateCommitments(userId: string, inputs: CommitmentInput[]): Promise<BulkCreateResult> {
  return withUser(userId, async (tx): Promise<BulkCreateResult> => {
    for (let i = 0; i < inputs.length; i++) {
      const err = validate(inputs[i]!);
      if (err) return { status: 'invalid', index: i, ...err };
    }
    const ids = inputs.map((inp) => inp.id ?? uuidv7());
    if (inputs.length > 0) await tx.insert(commitments).values(inputs.map((inp, i) => values(userId, inp, ids[i]!)));
    return { status: 'ok', ids };
  });
}

export type UpdateCommitmentResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'invalid'; field: string; error: string };

export function updateCommitment(
  userId: string,
  id: string,
  patch: Partial<CommitmentInput>,
): Promise<UpdateCommitmentResult> {
  return withUser(userId, async (tx): Promise<UpdateCommitmentResult> => {
    const existing = (
      await tx
        .select()
        .from(commitments)
        .where(and(eq(commitments.id, id), eq(commitments.userId, userId), isNull(commitments.deletedAt)))
        .limit(1)
    )[0];
    if (!existing) return { status: 'not_found' };

    const merged: CommitmentInput = {
      title: patch.title ?? existing.title,
      category: (patch.category ?? existing.category) as Category,
      location: patch.location ?? existing.location ?? undefined,
      startMin: patch.startMin ?? existing.startMin,
      durationMin: patch.durationMin ?? existing.durationMin,
      recurrence: patch.recurrence ?? existing.recurrence ?? undefined,
      validFrom: patch.validFrom ?? existing.validFrom,
      validUntil: patch.validUntil ?? existing.validUntil ?? undefined,
      remainingCount: patch.remainingCount ?? existing.remainingCount ?? undefined,
      color: patch.color ?? existing.color,
    };
    const err = validate(merged);
    if (err) return { status: 'invalid', ...err };

    await tx
      .update(commitments)
      .set({ ...values(userId, merged, id), updatedAt: new Date() })
      .where(eq(commitments.id, id));
    return { status: 'ok' };
  });
}

export function deleteCommitment(userId: string, id: string): Promise<{ status: 'ok' | 'not_found' }> {
  return withUser(userId, async (tx) => {
    const existing = (
      await tx
        .select({ id: commitments.id })
        .from(commitments)
        .where(and(eq(commitments.id, id), eq(commitments.userId, userId), isNull(commitments.deletedAt)))
        .limit(1)
    )[0];
    if (!existing) return { status: 'not_found' as const };
    await tx.update(commitments).set({ deletedAt: new Date() }).where(eq(commitments.id, id));
    return { status: 'ok' as const };
  });
}

export interface ListCommitmentsFilter {
  category?: Category;
  /** Only commitments valid on/around this date (validFrom <= date <= validUntil). FR-C14. */
  activeOn?: string;
}

export function listCommitments(userId: string, filter: ListCommitmentsFilter = {}) {
  return withUser(userId, async (tx) => {
    const conds: SQL[] = [eq(commitments.userId, userId), isNull(commitments.deletedAt)];
    if (filter.category) conds.push(eq(commitments.category, filter.category));
    if (filter.activeOn) {
      conds.push(lte(commitments.validFrom, filter.activeOn));
      conds.push(or(isNull(commitments.validUntil), gte(commitments.validUntil, filter.activeOn))!);
    }
    return tx.select().from(commitments).where(and(...conds));
  });
}

// --- instance exceptions (FR-C04) ---

async function upsertException(
  tx: Tx,
  userId: string,
  commitmentId: string,
  date: string,
  type: 'CANCELLED' | 'MODIFIED',
  startMin: number | null,
  durationMin: number | null,
): Promise<{ status: 'ok' } | { status: 'not_found' }> {
  const owns = (
    await tx
      .select({ id: commitments.id })
      .from(commitments)
      .where(and(eq(commitments.id, commitmentId), eq(commitments.userId, userId), isNull(commitments.deletedAt)))
      .limit(1)
  )[0];
  if (!owns) return { status: 'not_found' };

  await tx
    .insert(commitmentExceptions)
    .values({ userId, commitmentId, date, type, startMin, durationMin })
    .onConflictDoUpdate({
      target: [commitmentExceptions.commitmentId, commitmentExceptions.date],
      set: { type, startMin, durationMin },
    });
  return { status: 'ok' };
}

/** Cancel a single occurrence ("this date only", FR-C04). */
export function cancelInstance(userId: string, commitmentId: string, date: string) {
  return withUser(userId, (tx) => upsertException(tx, userId, commitmentId, date, 'CANCELLED', null, null));
}

/** Reschedule a single occurrence ("this date only", FR-C04). */
export function rescheduleInstance(
  userId: string,
  commitmentId: string,
  date: string,
  startMin: number,
  durationMin: number,
) {
  return withUser(userId, (tx) =>
    upsertException(tx, userId, commitmentId, date, 'MODIFIED', startMin, durationMin),
  );
}
