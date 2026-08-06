/**
 * Task CRUD (SRS §3.1, §5.1). Enforces the hierarchy and kind rules the DB can't:
 *
 *  - Max depth 2: a child cannot have children (no grandchildren).
 *  - A task with children is a container (estimateMin null, not placeable); a childless
 *    task is a leaf (estimateMin required, 5-60 in 5s).
 *  - Creating the first child converts the parent to a container; its placed blocks move
 *    to the unplaced zone (reason CONTAINER_CONVERSION).
 *  - Deleting the last child converts the parent back to a leaf (caller re-prompts estimate).
 *  - IMPORTANT/SLACK only on leaves. Switching a task to IMPORTANT is rejected if any date
 *    it is placed on already holds three important tasks (R-03), reporting those dates.
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { withUser, type Tx } from '../db/client.js';
import { blocks, tasks, unplacedItems } from '../db/schema.js';
import { uuidv7 } from '../lib/uuidv7.js';
import { bumpVersion } from './shared.js';

type Kind = 'NORMAL' | 'IMPORTANT' | 'SLACK';
type Status = 'TODO' | 'IN_PROGRESS' | 'DONE' | 'ARCHIVED';

const estimateValid = (v: number): boolean => v >= 5 && v <= 60 && v % 5 === 0;

async function childCount(tx: Tx, userId: string, parentId: string): Promise<number> {
  const rows = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.parentId, parentId), isNull(tasks.deletedAt)));
  return rows.length;
}

/** Convert a leaf to a container: null its estimate and spill its blocks to unplaced. */
async function convertToContainer(tx: Tx, userId: string, taskId: string): Promise<void> {
  const placed = await tx
    .select({ id: blocks.id, date: blocks.date, startMin: blocks.startMin, durationMin: blocks.durationMin })
    .from(blocks)
    .where(and(eq(blocks.userId, userId), eq(blocks.taskId, taskId), isNull(blocks.deletedAt)));

  if (placed.length > 0) {
    await tx.update(blocks).set({ deletedAt: new Date() }).where(inArray(blocks.id, placed.map((b) => b.id)));
    await tx.insert(unplacedItems).values(
      placed.map((b) => ({
        userId,
        taskId,
        date: b.date,
        durationMin: b.durationMin,
        reason: 'CONTAINER_CONVERSION' as const,
        originStartMin: b.startMin,
      })),
    );
    for (const date of new Set(placed.map((b) => b.date))) await bumpVersion(tx, userId, date);
  }
  await tx.update(tasks).set({ estimateMin: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

// --- create ---

export interface CreateTaskInput {
  id?: string;
  title: string;
  note?: string;
  parentId?: string;
  kind?: Kind;
  estimateMin?: number;
  sortOrder?: number;
}
export type CreateTaskResult =
  | { status: 'ok'; id: string; parentConverted: boolean }
  | { status: 'parent_not_found' }
  | { status: 'max_depth' }
  | { status: 'estimate_required' }
  | { status: 'estimate_invalid' };

export function createTask(userId: string, input: CreateTaskInput): Promise<CreateTaskResult> {
  return withUser(userId, async (tx): Promise<CreateTaskResult> => {
    let parentConverted = false;

    if (input.parentId) {
      const parent = (
        await tx
          .select({ id: tasks.id, parentId: tasks.parentId })
          .from(tasks)
          .where(and(eq(tasks.id, input.parentId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
          .limit(1)
      )[0];
      if (!parent) return { status: 'parent_not_found' };
      if (parent.parentId) return { status: 'max_depth' }; // parent is itself a child
      if ((await childCount(tx, userId, parent.id)) === 0) {
        await convertToContainer(tx, userId, parent.id); // first child ⇒ parent becomes container
        parentConverted = true;
      }
    }

    // A newly created task is always a leaf, so it needs a valid estimate.
    if (input.estimateMin == null) return { status: 'estimate_required' };
    if (!estimateValid(input.estimateMin)) return { status: 'estimate_invalid' };

    const id = input.id ?? uuidv7();
    await tx.insert(tasks).values({
      id,
      userId,
      title: input.title,
      note: input.note ?? null,
      parentId: input.parentId ?? null,
      kind: input.kind ?? 'NORMAL',
      estimateMin: input.estimateMin,
      sortOrder: input.sortOrder ?? 0,
    });
    return { status: 'ok', id, parentConverted };
  });
}

// --- update ---

export interface UpdateTaskInput {
  id: string;
  title?: string;
  note?: string | null;
  estimateMin?: number;
  kind?: Kind;
  status?: Status;
  sortOrder?: number;
}
export type UpdateTaskResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'kind_leaf_only' }
  | { status: 'estimate_container' }
  | { status: 'estimate_invalid' }
  | { status: 'important_conflict'; dates: string[] };

export function updateTask(userId: string, input: UpdateTaskInput): Promise<UpdateTaskResult> {
  return withUser(userId, async (tx): Promise<UpdateTaskResult> => {
    const task = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
        .limit(1)
    )[0];
    if (!task) return { status: 'not_found' };
    const isContainer = (await childCount(tx, userId, input.id)) > 0;

    if (input.kind === 'IMPORTANT' || input.kind === 'SLACK') {
      if (isContainer) return { status: 'kind_leaf_only' };
    }
    if (input.kind === 'IMPORTANT') {
      // R-03 across every date this task is placed on.
      const dates = [
        ...new Set(
          (
            await tx
              .select({ date: blocks.date })
              .from(blocks)
              .where(and(eq(blocks.userId, userId), eq(blocks.taskId, input.id), isNull(blocks.deletedAt)))
          ).map((r) => r.date),
        ),
      ];
      const offending: string[] = [];
      for (const date of dates) {
        const others = await tx
          .select({ taskId: blocks.taskId })
          .from(blocks)
          .innerJoin(tasks, eq(blocks.taskId, tasks.id))
          .where(
            and(
              eq(blocks.userId, userId),
              eq(blocks.date, date),
              isNull(blocks.deletedAt),
              eq(tasks.kind, 'IMPORTANT'),
              ne(blocks.taskId, input.id),
            ),
          );
        if (new Set(others.map((o) => o.taskId)).size >= 3) offending.push(date);
      }
      if (offending.length > 0) return { status: 'important_conflict', dates: offending };
    }

    if (input.estimateMin != null) {
      if (isContainer) return { status: 'estimate_container' };
      if (!estimateValid(input.estimateMin)) return { status: 'estimate_invalid' };
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title != null) patch.title = input.title;
    if (input.note !== undefined) patch.note = input.note;
    if (input.estimateMin != null) patch.estimateMin = input.estimateMin;
    if (input.kind != null) patch.kind = input.kind;
    if (input.sortOrder != null) patch.sortOrder = input.sortOrder;
    if (input.status != null) {
      patch.status = input.status;
      patch.completedAt = input.status === 'DONE' ? new Date() : null;
    }
    await tx.update(tasks).set(patch).where(eq(tasks.id, input.id));
    return { status: 'ok' };
  });
}

// --- delete ---

export type DeleteTaskResult =
  | { status: 'ok'; parentNeedsEstimate: string | null }
  | { status: 'not_found' };

/** Soft-delete a task and its descendants + their blocks. Reverts a now-childless parent to a leaf. */
export function deleteTask(userId: string, id: string): Promise<DeleteTaskResult> {
  return withUser(userId, async (tx): Promise<DeleteTaskResult> => {
    const task = (
      await tx
        .select({ id: tasks.id, parentId: tasks.parentId })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
        .limit(1)
    )[0];
    if (!task) return { status: 'not_found' };

    const childIds = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.userId, userId), eq(tasks.parentId, id), isNull(tasks.deletedAt)))
    ).map((r) => r.id);
    const ids = [id, ...childIds];

    const now = new Date();
    const placed = await tx
      .select({ id: blocks.id, date: blocks.date })
      .from(blocks)
      .where(and(eq(blocks.userId, userId), inArray(blocks.taskId, ids), isNull(blocks.deletedAt)));
    if (placed.length > 0) {
      await tx.update(blocks).set({ deletedAt: now }).where(inArray(blocks.id, placed.map((b) => b.id)));
      for (const date of new Set(placed.map((b) => b.date))) await bumpVersion(tx, userId, date);
    }
    await tx.update(tasks).set({ deletedAt: now }).where(inArray(tasks.id, ids));

    let parentNeedsEstimate: string | null = null;
    if (task.parentId && (await childCount(tx, userId, task.parentId)) === 0) {
      parentNeedsEstimate = task.parentId; // reverted to a leaf; client re-prompts estimate
    }
    return { status: 'ok', parentNeedsEstimate };
  });
}

// --- list ---

export interface TaskView {
  id: string;
  title: string;
  note: string | null;
  parentId: string | null;
  kind: Kind;
  estimateMin: number | null;
  status: Status;
  sortOrder: number;
  isContainer: boolean;
  childCount: number;
  /** Completion ratio of children, 0..1, only for containers (§3.1). */
  progress: number | null;
}

export function listTasks(userId: string): Promise<TaskView[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)));

    const childrenByParent = new Map<string, { done: number; total: number }>();
    for (const t of rows) {
      if (!t.parentId) continue;
      const agg = childrenByParent.get(t.parentId) ?? { done: 0, total: 0 };
      agg.total += 1;
      if (t.status === 'DONE') agg.done += 1;
      childrenByParent.set(t.parentId, agg);
    }

    return rows
      .map((t): TaskView => {
        const agg = childrenByParent.get(t.id);
        const childCount = agg?.total ?? 0;
        return {
          id: t.id,
          title: t.title,
          note: t.note,
          parentId: t.parentId,
          kind: t.kind,
          estimateMin: t.estimateMin,
          status: t.status,
          sortOrder: t.sortOrder,
          isContainer: childCount > 0,
          childCount,
          progress: agg ? (agg.total === 0 ? 0 : agg.done / agg.total) : null,
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
  });
}
