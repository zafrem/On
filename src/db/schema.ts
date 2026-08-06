/**
 * On — database schema (SRS §3).
 *
 * This file is the typed source for query building. It is NOT the authority for
 * migrations: the gist EXCLUDE constraint (R-01), RLS policies (§6.3), and some
 * CHECK constraints are hand-written in migrations/0001_init.sql, because Drizzle
 * cannot express them. Keep the two in sync by hand.
 *
 * Conventions:
 *  - IDs are UUIDv7 generated client-side (NFR-11). Columns carry a
 *    gen_random_uuid() default only as a safety net.
 *  - All times are minutes from the date's midnight (Int). May exceed 1440 when a
 *    waking day extends past midnight (§3.2, §3.4).
 *  - Deletion is soft: deletedAt is set, rows are never physically removed except
 *    on account deletion (NFR-07).
 */
import {
  boolean,
  check,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const taskKind = pgEnum('task_kind', ['NORMAL', 'IMPORTANT', 'SLACK']);
export const taskStatus = pgEnum('task_status', ['TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED']);
export const commitmentCategory = pgEnum('commitment_category', [
  'SCHOOL',
  'ACADEMY',
  'EXERCISE',
  'WORK',
  'APPOINTMENT',
  'OTHER',
]);
export const commitmentExceptionType = pgEnum('commitment_exception_type', ['CANCELLED', 'MODIFIED']);
export const unplacedReason = pgEnum('unplaced_reason', [
  'PUSHED_OUT',
  'MANUAL',
  'CONTAINER_CONVERSION',
  'SLEEP_BOUNDARY',
]);
export const actualSource = pgEnum('actual_source', ['TIMER', 'MANUAL']);
export const pushPlatform = pgEnum('push_platform', ['IOS', 'ANDROID', 'DESKTOP']);

// ---------------------------------------------------------------------------
// §3.0 User & Profile
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull(), // IANA tz. Single tz per v1 (NFR-05).
  defaultWakeMin: integer('default_wake_min').notNull(),
  defaultSleepMin: integer('default_sleep_min').notNull(), // 1440+ when past midnight
  slackAllowanceMin: integer('slack_allowance_min').notNull().default(30),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §3.1 Task
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note'),
    parentId: uuid('parent_id'), // self-reference; two-level max enforced in API
    kind: taskKind('kind').notNull().default('NORMAL'),
    estimateMin: integer('estimate_min'), // null for containers; 5-60 for leaves
    status: taskStatus('status').notNull().default('TODO'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('tasks_title_len', sql`char_length(${t.title}) between 1 and 120`),
    check(
      'tasks_estimate_range',
      sql`${t.estimateMin} is null or (${t.estimateMin} between 5 and 60 and ${t.estimateMin} % 5 = 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// §3.2 Block  (plan lane)
// ---------------------------------------------------------------------------

export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    startMin: integer('start_min').notNull(), // may exceed 1440 (§3.2)
    durationMin: integer('duration_min').notNull(), // 5-60
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('blocks_start_grid', sql`${t.startMin} >= 0 and ${t.startMin} % 5 = 0`),
    check('blocks_duration_range', sql`${t.durationMin} between 5 and 60`),
    // NOTE: block-vs-block non-overlap (R-01) is a gist EXCLUDE constraint added in
    // migrations/0001_init.sql — Drizzle cannot express EXCLUDE.
  ],
);

// ---------------------------------------------------------------------------
// §3.3 Commitment (+ Exception)
// ---------------------------------------------------------------------------

export const commitments = pgTable(
  'commitments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: commitmentCategory('category').notNull().default('OTHER'),
    location: text('location'),
    startMin: integer('start_min').notNull(),
    durationMin: integer('duration_min').notNull(), // min 5, no upper bound
    recurrence: text('recurrence'), // RFC 5545 RRULE; null = one-off
    validFrom: date('valid_from').notNull(),
    validUntil: date('valid_until'),
    remainingCount: integer('remaining_count'), // prepaid packages
    color: text('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('commitments_start_grid', sql`${t.startMin} >= 0 and ${t.startMin} % 5 = 0`),
    check('commitments_duration_min', sql`${t.durationMin} >= 5`),
  ],
);

export const commitmentExceptions = pgTable(
  'commitment_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // user_id denormalized from the parent commitment so RLS can key on it directly.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commitmentId: uuid('commitment_id')
      .notNull()
      .references(() => commitments.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    type: commitmentExceptionType('type').notNull(),
    startMin: integer('start_min'), // overrides for MODIFIED
    durationMin: integer('duration_min'),
  },
  (t) => [unique('commitment_exceptions_one_per_date').on(t.commitmentId, t.date)],
);

// ---------------------------------------------------------------------------
// §3.4 DayMarker
// ---------------------------------------------------------------------------

export const dayMarkers = pgTable(
  'day_markers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    plannedWakeMin: integer('planned_wake_min').notNull(),
    plannedSleepMin: integer('planned_sleep_min').notNull(), // 1440+ when past midnight
    actualWakeMin: integer('actual_wake_min'),
    actualSleepMin: integer('actual_sleep_min'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('day_markers_user_date').on(t.userId, t.date)],
);

// ---------------------------------------------------------------------------
// §3.5 ActualEntry  (actual lane)
// ---------------------------------------------------------------------------

export const actualEntries = pgTable(
  'actual_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    commitmentId: uuid('commitment_id').references(() => commitments.id, { onDelete: 'set null' }),
    label: text('label').notNull().default(''), // required when both IDs are null
    date: date('date').notNull(), // attributed by wake→sleep window (§3.5)
    startMin: integer('start_min').notNull(),
    durationMin: integer('duration_min').notNull(), // min 5, no upper bound
    source: actualSource('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('actual_entries_duration_min', sql`${t.durationMin} >= 5`),
    check(
      'actual_entries_ref_or_label',
      sql`${t.taskId} is not null or ${t.commitmentId} is not null or char_length(trim(${t.label})) > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// §3.6 UnplacedItem
// ---------------------------------------------------------------------------

export const unplacedItems = pgTable('unplaced_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  durationMin: integer('duration_min').notNull(),
  reason: unplacedReason('reason').notNull(),
  originStartMin: integer('origin_start_min'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// §3.7 ActiveTimer — at most one per user
// ---------------------------------------------------------------------------

export const activeTimers = pgTable('active_timers', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  commitmentId: uuid('commitment_id').references(() => commitments.id, { onDelete: 'set null' }),
  label: text('label').notNull().default(''),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  expectedEndAt: timestamp('expected_end_at', { withTimezone: true }),
  deviceId: text('device_id').notNull(),
});

// ---------------------------------------------------------------------------
// §3.8 DayVersion — optimistic-concurrency token, per user per day
// ---------------------------------------------------------------------------

export const dayVersions = pgTable(
  'day_versions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('day_versions_pk').on(t.userId, t.date)],
);

// ---------------------------------------------------------------------------
// §3.9 PushSubscription
// ---------------------------------------------------------------------------

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    deviceLabel: text('device_label').notNull(),
    platform: pushPlatform('platform').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    failCount: integer('fail_count').notNull().default(0),
  },
  (t) => [unique('push_subscriptions_user_endpoint').on(t.userId, t.endpoint)],
);

// ---------------------------------------------------------------------------
// §3.10 NotificationPreference — one per user
// ---------------------------------------------------------------------------

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  blockStartLeadMin: integer('block_start_lead_min').default(5), // null disables
  blockEndEnabled: boolean('block_end_enabled').notNull().default(true),
  overrunEnabled: boolean('overrun_enabled').notNull().default(true),
  slackGraceEnabled: boolean('slack_grace_enabled').notNull().default(true),
  sleepApproachLeadMin: integer('sleep_approach_lead_min'),
  dailyReviewMin: integer('daily_review_min'),
  quietFromMin: integer('quiet_from_min'),
  quietToMin: integer('quiet_to_min'),
});
