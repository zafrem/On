-- On — initial schema (SRS §3, §6.3)
-- Authoritative DDL. src/db/schema.ts mirrors this for typed queries but is not the
-- source of truth. Keep them in sync by hand.
--
-- RLS model (§6.3): every tenant table has FORCE ROW LEVEL SECURITY with a policy
-- keyed on current_setting('app.user_id'). The application MUST run tenant queries
-- inside a transaction that has called set_config('app.user_id', <uuid>, true) — see
-- withUser() in src/db/client.ts. FORCE makes the policy apply even to the table
-- owner, so RLS is real even with Neon's single-role setup. Signup sets app.user_id
-- to the new user's own id before inserting, so the WITH CHECK clauses pass.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- gist opclasses for uuid/date equality
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid() safety-net default

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE task_kind AS ENUM ('NORMAL', 'IMPORTANT', 'SLACK');
CREATE TYPE task_status AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'ARCHIVED');
CREATE TYPE commitment_category AS ENUM ('SCHOOL', 'ACADEMY', 'EXERCISE', 'WORK', 'APPOINTMENT', 'OTHER');
CREATE TYPE commitment_exception_type AS ENUM ('CANCELLED', 'MODIFIED');
CREATE TYPE unplaced_reason AS ENUM ('PUSHED_OUT', 'MANUAL', 'CONTAINER_CONVERSION', 'SLEEP_BOUNDARY');
CREATE TYPE actual_source AS ENUM ('TIMER', 'MANUAL');
CREATE TYPE push_platform AS ENUM ('IOS', 'ANDROID', 'DESKTOP');

-- ---------------------------------------------------------------------------
-- §3.0 User & Profile
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone            text NOT NULL,
  default_wake_min    integer NOT NULL,
  default_sleep_min   integer NOT NULL,
  slack_allowance_min integer NOT NULL DEFAULT 30,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- §3.1 Task
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  note         text,
  parent_id    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  kind         task_kind NOT NULL DEFAULT 'NORMAL',
  estimate_min integer,
  status       task_status NOT NULL DEFAULT 'TODO',
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at   timestamptz,
  CONSTRAINT tasks_title_len CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT tasks_estimate_range CHECK (
    estimate_min IS NULL OR (estimate_min BETWEEN 5 AND 60 AND estimate_min % 5 = 0)
  )
);
CREATE INDEX tasks_user_idx ON tasks (user_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_id);

-- ---------------------------------------------------------------------------
-- §3.2 Block (plan lane)
-- ---------------------------------------------------------------------------
CREATE TABLE blocks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  date         date NOT NULL,
  start_min    integer NOT NULL,
  duration_min integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT blocks_start_grid CHECK (start_min >= 0 AND start_min % 5 = 0),
  CONSTRAINT blocks_duration_range CHECK (duration_min BETWEEN 5 AND 60),
  -- R-01: block-vs-block non-overlap per user per day. Live blocks only.
  CONSTRAINT blocks_no_overlap EXCLUDE USING gist (
    user_id WITH =,
    date WITH =,
    int4range(start_min, start_min + duration_min) WITH &&
  ) WHERE (deleted_at IS NULL)
);
CREATE INDEX blocks_user_date_idx ON blocks (user_id, date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- §3.3 Commitment (+ Exception)
-- ---------------------------------------------------------------------------
CREATE TABLE commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  category        commitment_category NOT NULL DEFAULT 'OTHER',
  location        text,
  start_min       integer NOT NULL,
  duration_min    integer NOT NULL,
  recurrence      text,
  valid_from      date NOT NULL,
  valid_until     date,
  remaining_count integer,
  color           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT commitments_start_grid CHECK (start_min >= 0 AND start_min % 5 = 0),
  CONSTRAINT commitments_duration_min CHECK (duration_min >= 5)
);
CREATE INDEX commitments_user_idx ON commitments (user_id) WHERE deleted_at IS NULL;

CREATE TABLE commitment_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  date          date NOT NULL,
  type          commitment_exception_type NOT NULL,
  start_min     integer,
  duration_min  integer,
  CONSTRAINT commitment_exceptions_one_per_date UNIQUE (commitment_id, date)
);

-- ---------------------------------------------------------------------------
-- §3.4 DayMarker
-- ---------------------------------------------------------------------------
CREATE TABLE day_markers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date              date NOT NULL,
  planned_wake_min  integer NOT NULL,
  planned_sleep_min integer NOT NULL,
  actual_wake_min   integer,
  actual_sleep_min  integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX day_markers_user_date ON day_markers (user_id, date);

-- ---------------------------------------------------------------------------
-- §3.5 ActualEntry (actual lane)
-- ---------------------------------------------------------------------------
CREATE TABLE actual_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  commitment_id uuid REFERENCES commitments(id) ON DELETE SET NULL,
  label         text NOT NULL DEFAULT '',
  date          date NOT NULL,
  start_min     integer NOT NULL,
  duration_min  integer NOT NULL,
  source        actual_source NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT actual_entries_duration_min CHECK (duration_min >= 5),
  CONSTRAINT actual_entries_ref_or_label CHECK (
    task_id IS NOT NULL OR commitment_id IS NOT NULL OR char_length(trim(label)) > 0
  )
);
CREATE INDEX actual_entries_user_date_idx ON actual_entries (user_id, date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- §3.6 UnplacedItem
-- ---------------------------------------------------------------------------
CREATE TABLE unplaced_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  date             date NOT NULL,
  duration_min     integer NOT NULL,
  reason           unplaced_reason NOT NULL,
  origin_start_min integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unplaced_items_user_date_idx ON unplaced_items (user_id, date);

-- ---------------------------------------------------------------------------
-- §3.7 ActiveTimer — at most one per user (PK enforces it)
-- ---------------------------------------------------------------------------
CREATE TABLE active_timers (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  commitment_id   uuid REFERENCES commitments(id) ON DELETE SET NULL,
  label           text NOT NULL DEFAULT '',
  started_at      timestamptz NOT NULL,
  expected_end_at timestamptz,
  device_id       text NOT NULL
);

-- ---------------------------------------------------------------------------
-- §3.8 DayVersion
-- ---------------------------------------------------------------------------
CREATE TABLE day_versions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT day_versions_pk PRIMARY KEY (user_id, date)
);

-- ---------------------------------------------------------------------------
-- §3.9 PushSubscription
-- ---------------------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  device_label text NOT NULL,
  platform     push_platform NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  fail_count   integer NOT NULL DEFAULT 0,
  CONSTRAINT push_subscriptions_user_endpoint UNIQUE (user_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- §3.10 NotificationPreference — one per user
-- ---------------------------------------------------------------------------
CREATE TABLE notification_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  block_start_lead_min    integer DEFAULT 5,
  block_end_enabled       boolean NOT NULL DEFAULT true,
  overrun_enabled         boolean NOT NULL DEFAULT true,
  slack_grace_enabled     boolean NOT NULL DEFAULT true,
  sleep_approach_lead_min integer,
  daily_review_min        integer,
  quiet_from_min          integer,
  quiet_to_min            integer
);

-- ---------------------------------------------------------------------------
-- Row-Level Security (§6.3)
-- ---------------------------------------------------------------------------
-- Helper: the current request's user id, NULL when unset (default-deny).
-- Inlined per policy as current_setting('app.user_id', true)::uuid.

-- users: tenant key is the row's own id.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON users
  USING (id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (id = current_setting('app.user_id', true)::uuid);

-- Every other tenant table: key on user_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles', 'tasks', 'blocks', 'commitments', 'commitment_exceptions',
    'day_markers', 'actual_entries', 'unplaced_items', 'active_timers',
    'day_versions', 'push_subscriptions', 'notification_preferences'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY user_isolation ON %I '
      'USING (user_id = current_setting(''app.user_id'', true)::uuid) '
      'WITH CHECK (user_id = current_setting(''app.user_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;
