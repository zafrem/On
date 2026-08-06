# On — System Requirements Specification

**Version** v0.4
**Date** 2026-08-06
**Previous** v0.3

---

## 0. Changes from v0.3

| Area | Change |
|---|---|
| §3.0 | **User** and **Profile** entities added. Profile holds timezone and default wake/sleep |
| §3.2 | `Block.startMin` **upper bound defined**. May exceed 1440 on a day extending past midnight |
| §3.5 | `ActualEntry` **date-attribution rule** added. Attributed by wake→sleep window (resolves Q-04) |
| §5.8 | `Committed` redefined as the **union** of commitment intervals, not their sum |
| §6.3 | Non-overlap DB defense **scoped** to block-vs-block. Block-vs-commitment is API-only |
| §11 | Q-03, Q-04, Q-05 **resolved**. Three new product questions recorded |

---

## 1. Overview

### 1.1 Product Definition

**On** is a personal timeboxing tool that combines a task list with a timeline. Users pull items from the task list and place them onto the timeline like sticky notes (the plan), then record what they actually did in a separate lane as the day progresses (the actual). The ultimate goal is to correct the user's own time estimation ability as the gap between these two records accumulates.

### 1.2 Product Philosophy

On's core value lies in its **constraints**, not in feature richness. The five constraints below reinforce one another; relaxing any of them arbitrarily dissolves the product's identity.

| Constraint | Behavior it forces |
|---|---|
| Maximum 60 minutes per block | Break large work into executable units |
| Three important tasks per day | Actually choose priorities |
| No overlap in the plan lane | Confront how much fits in a day |
| Plan and actual recorded separately | Expose the gap between estimate and reality |
| Day boundary = wake to sleep | Make clear that more time means less sleep |

### 1.3 Scope

**In scope (v1)** — Multi-user, task management and decomposition, commitments with recurrence, placement, execution logging, wake/sleep tracking, notifications, estimation variance analysis. Delivered as a PWA.

**Out of scope (v1)** — Team collaboration, external calendar integration, automatic scheduling, native apps, widgets, smartwatch support

### 1.4 Glossary

| Term | Definition |
|---|---|
| Task | A to-do item. The user decides whether and when to do it |
| Block | An instance of a task placed on the plan lane, occupying time |
| Commitment | An externally fixed obligation. Classes, academies, PT sessions |
| Plan Lane | The area showing planned work. No overlap allowed |
| Actual Lane | The area showing what actually happened. Overlap allowed |
| Unplaced Zone | Holding area for blocks that were pushed out or unplaced |
| Important Task | A priority task, limited to three per day |
| Slack Task | A task for creative work. Granted a 30-minute overrun allowance |
| Day Boundary | The wake time and sleep time for a given date |
| Available Time | Total day span minus commitments |

---

## 2. Core Rules

- **R-01** Blocks and commitments on the plan lane never overlap.
- **R-02** Block duration is between 5 and 60 minutes, in 5-minute increments only.
- **R-03** At most three distinct important tasks may be placed on any given day.
- **R-04** The actual lane permits overlap and accepts entries that were never planned.
- **R-05** A block that must move but has nowhere to go is never deleted; it moves to the unplaced zone.
- **R-06** Commitments never move automatically and are exempt from the 60-minute cap.
- **R-07** All changes caused by a single placement action form one transaction and are reverted by a single undo.
- **R-08** Blocks cannot be placed before the wake time or after the sleep time.
- **R-09** The system never starts a timer without an explicit user action.

---

## 3. Domain Model

### 3.0 User and Profile

Every entity carries `userId`. This section defines what it points to and where profile-level defaults live.

```
User {
  id        : UUID          // PK. Referenced by every entity's userId
  email     : String        // unique, login identity
  createdAt : DateTime
  deletedAt : DateTime | null
}
```

```
Profile {
  userId            : UUID   // PK. 1:1 with User
  timezone          : String // IANA tz, e.g. "Asia/Seoul". Single tz per v1 (NFR-05)
  defaultWakeMin    : Int    // minutes from midnight
  defaultSleepMin   : Int    // 1440+ when past midnight, mirrors DayMarker
  slackAllowanceMin : Int    // default 30. Constant until Q-02 is decided
  createdAt         : DateTime
  updatedAt         : DateTime
}
```

**Rules**

- One `Profile` per `User`, created at signup with system defaults.
- `defaultWakeMin` / `defaultSleepMin` seed every new `DayMarker` (§3.4). A per-date override does not alter the profile.
- `timezone` is the single source of truth for all minute-from-midnight conversions (NFR-05, NFR-06).
- **Multi-user in v1 is account separation only.** `userId` is the sole tenant key; RLS (§6.3) isolates on it. No cross-user sharing schema is introduced (Q-05).
- `slackAllowanceMin` is modeled here so Q-02 resolves without a schema change. Until then the API treats it as a constant 30 and exposes no editor.

### 3.1 Task

```
Task {
  id            : UUID
  userId        : UUID
  title         : String (1-120 chars)
  note          : Text | null
  parentId      : UUID | null
  kind          : NORMAL | IMPORTANT | SLACK
  estimateMin   : Int | null       // 5-60, 5-min increments. null for containers
  status        : TODO | IN_PROGRESS | DONE | ARCHIVED
  sortOrder     : Int
  createdAt     : DateTime
  updatedAt     : DateTime
  completedAt   : DateTime | null
  deletedAt     : DateTime | null
}
```

**Hierarchy rules**

- Maximum depth is two levels. Grandchild nodes cannot be created.
- A task with children is a **container** and cannot be placed. Its `estimateMin` is null.
- A task without children is a **leaf** and can be placed. Its `estimateMin` is required.
- Creating the first child converts a task to a container; any placed blocks move to the unplaced zone. Confirmation is required.
- Deleting the last child converts it back to a leaf and prompts for `estimateMin`.
- Container progress is derived from the completion ratio of its children and cannot be set directly.

**Kind rules**

- `IMPORTANT` and `SLACK` can only be assigned to leaves.
- A container's kind is display-only and is not inherited by children.
- Changing to `IMPORTANT` triggers a three-per-day check across every date where the task is placed. If any date would be violated, the change is rejected and the offending dates are reported.

### 3.2 Block

```
Block {
  id          : UUID
  userId      : UUID
  taskId      : UUID
  date        : Date
  startMin    : Int          // minutes from the block's date midnight, multiple of 5.
                             // May exceed 1440 when the waking day extends past midnight.
                             // Bound: startMin + durationMin <= plannedSleepMin of the date (R-08).
  durationMin : Int          // 5-60
  createdAt   : DateTime
  updatedAt   : DateTime
  deletedAt   : DateTime | null
}
```

- A single task may be split into multiple blocks on the same day.
- A block's `durationMin` is adjustable independently of the task's `estimateMin`.
- A block belongs to the `date` whose wake→sleep window contains its start, on the same continuous axis as `DayMarker`. A block starting at 00:30 on a day that sleeps at 01:30 has `date` = the *previous* calendar date and `startMin` = 1470.

### 3.3 Commitment

Represents an externally determined obligation. Unlike a task, whether it happens is not the user's choice, and it is exempt from the duration cap and priority limits.

```
Commitment {
  id             : UUID
  userId         : UUID
  title          : String
  category       : SCHOOL | ACADEMY | EXERCISE | WORK | APPOINTMENT | OTHER
  location       : String | null
  startMin       : Int
  durationMin    : Int          // minimum 5. No upper bound
  recurrence     : RRule | null // null means one-off
  validFrom      : Date
  validUntil     : Date | null
  remainingCount : Int | null   // sessions left for prepaid packages
  color          : String
  createdAt      : DateTime
  updatedAt      : DateTime
  deletedAt      : DateTime | null
}
```

**Characteristics**

- The 60-minute cap does not apply. A three-hour class or two-hour academy session is represented as-is.
- Always fixed. Never subject to push-down, and acts as a terminator for push-down chains.
- Excluded from the three-important-tasks count.
- No hierarchy. Cannot be decomposed.
- Commitments may overlap one another. Real schedules collide, and the system has no grounds to prevent it.

**Recurrence**

- Uses RFC 5545 RRULE syntax, so external calendar data can be reused later.
- Supported subset (v1) — `FREQ=DAILY|WEEKLY|MONTHLY`, `BYDAY`, `INTERVAL`, `COUNT`, `UNTIL`
- `validFrom` / `validUntil` define the validity period, expressing semesters or quarters.
- Recurrence instances are not materialized in the database. They are expanded at query time, with only exceptions stored.

```
CommitmentException {
  id           : UUID
  commitmentId : UUID
  date         : Date
  type         : CANCELLED | MODIFIED
  startMin     : Int | null
  durationMin  : Int | null
}
```

- **CANCELLED** — School closure, absence, cancelled session. That date only is excluded.
- **MODIFIED** — Shortened class, time change. That date's values are overridden.

**Session-based commitments**

- When `remainingCount` is set, the remaining sessions are displayed.
- The count decrements on each completion. At zero, recurrence ends and the user is notified.

### 3.4 DayMarker

```
DayMarker {
  id              : UUID
  userId          : UUID
  date            : Date
  plannedWakeMin  : Int
  plannedSleepMin : Int          // 1440+ when past midnight
  actualWakeMin   : Int | null
  actualSleepMin  : Int | null
  createdAt       : DateTime
  updatedAt       : DateTime
}
```

- Planned wake and sleep times define the day boundary for that date.
- A sleep time past midnight is stored as 1440 or greater. Going to bed at 1 AM is 1500.
- Each date inherits the profile default and can be overridden individually.
- Actual values may be entered manually or suggested from the first timer start and last activity end.

### 3.5 ActualEntry

```
ActualEntry {
  id           : UUID
  userId       : UUID
  taskId       : UUID | null
  commitmentId : UUID | null
  label        : String        // required when both IDs are null
  date         : Date
  startMin     : Int
  durationMin  : Int           // minimum 5. No upper bound
  source       : TIMER | MANUAL
  createdAt    : DateTime
  updatedAt    : DateTime
  deletedAt    : DateTime | null
}
```

**Date attribution**

- An entry is attributed to the `date` whose **wake→sleep window** contains its `startMin`, identical to the block rule (§3.2) — not to the wall-clock calendar date. An entry logged at 00:45 on a day that sleeps at 01:30 is attributed to the prior date with `startMin` = 1485.
- Attribution is resolved at write time from the active `DayMarker`, so reads filter on `date` alone.
- If no `DayMarker` exists yet for the containing window, attribute to the calendar date of the start and let FR-D05 reconcile on confirmation.

### 3.6 UnplacedItem

```
UnplacedItem {
  id             : UUID
  userId         : UUID
  taskId         : UUID
  date           : Date
  durationMin    : Int
  reason         : PUSHED_OUT | MANUAL | CONTAINER_CONVERSION | SLEEP_BOUNDARY
  originStartMin : Int | null
  createdAt      : DateTime
}
```

### 3.7 ActiveTimer

```
ActiveTimer {
  userId        : UUID   // PK. At most one per user
  taskId        : UUID | null
  commitmentId  : UUID | null
  label         : String
  startedAt     : DateTime
  expectedEndAt : DateTime | null  // used for notification scheduling
  deviceId      : String
}
```

- Exactly one per user. This is the only way to enforce the single-timer rule across multiple devices.
- Each device renders elapsed time computed from `startedAt`, so device clock drift has no effect.

### 3.8 DayVersion

```
DayVersion {
  userId    : UUID
  date      : Date
  version   : Int
  updatedAt : DateTime
}
```

### 3.9 PushSubscription

```
PushSubscription {
  id          : UUID
  userId      : UUID
  endpoint    : String
  p256dh      : String
  auth        : String
  deviceLabel : String        // user-facing device name
  platform    : IOS | ANDROID | DESKTOP
  enabled     : Boolean
  lastSeenAt  : DateTime      // last activity, used to select delivery target
  createdAt   : DateTime
  failCount   : Int           // consecutive delivery failures
}
```

### 3.10 NotificationPreference

```
NotificationPreference {
  userId               : UUID
  blockStartLeadMin    : Int | null   // null disables. Default 5
  blockEndEnabled      : Boolean
  overrunEnabled       : Boolean
  slackGraceEnabled    : Boolean
  sleepApproachLeadMin : Int | null
  dailyReviewMin       : Int | null   // time for the end-of-day review prompt
  quietFromMin         : Int | null   // do-not-disturb window
  quietToMin           : Int | null
}
```

---

## 4. Platforms and Screens

### 4.1 Platform Roles

The split is by *kind of work*, not screen size. This is a single PWA codebase, not two separate programs.

| | Desktop / Tablet | Mobile |
|---|---|---|
| Role | Planning and review | Execution and logging |
| Primary activity | Decomposition, estimation, placement, commitment management, analytics | Timer, actual logging, quick capture |
| Layout | Two panels | Three tabs |

- **FR-M01** There is a single entry URL. Only the layout changes with screen size.
- **FR-M02** Features unavailable on mobile are not hidden; the system states "this action is available on desktop."
- **FR-M03** The same concept uses the same color and the same wording on every screen.

### 4.2 Desktop / Tablet

- Two-panel layout: task list on the left, timeline on the right.
- The timeline shows the plan lane and actual lane side by side. Commitments render as a background layer of the plan lane.
- The header shows three important-task slots and the available-time budget bar.
- The unplaced zone is a pinned section at the top of the task list, visible only when it has items.
- Analytics screens are available on this platform only.

### 4.3 Commitment Management Screen

Commitments have a fundamentally different edit cadence from tasks. Tasks are touched daily; a timetable is entered once a semester and left alone for months. Their nature is closer to *settings* than to *to-dos*.

- **FR-C10** Commitments are managed on a **separate screen**, distinct from the task list.
- **FR-C11** Commitments never appear in the task list panel. They appear on the timeline only as a background layer.
- **FR-C12** The management screen provides a **weekly grid editor** as its primary view. Users fill cells in a day-by-time grid to register many entries in sequence. Single-item form entry is secondary.
- **FR-C13** Existing entries can be dragged or resized directly within the grid.
- **FR-C14** Filters by category and by validity period are provided.
- **FR-C15** On mobile, the commitment screen is read-only, except that individual instances may be cancelled or rescheduled.

### 4.4 Mobile

**Now tab** (default entry)

- One current block or commitment, displayed large.
- Timer start/stop button.
- Preview of the next item.
- Button to log an unplanned activity on the spot.

**Today tab**

- Vertical timeline. The plan lane dominates; actual entries appear as a thin ribbon on the right.
- Tapping the ribbon expands a plan-versus-actual comparison for that span.
- Current-time indicator with auto-scroll.
- Wake and sleep markers at either end of the timeline, editable in place.

**Tasks tab**

- Task list oriented toward reading and quick capture.
- Decomposition and precise duration editing redirect to desktop.
- Unplaced zone visible; placement supported.

---

## 5. Functional Requirements

### 5.1 Task Management

- **FR-T01** Users can create, edit, delete, and archive tasks.
- **FR-T02** Users can write a large item as a root task and decompose it into children.
- **FR-T03** During decomposition the system presents child input forms in sequence so several can be written at once.
- **FR-T04** The sum of child durations is displayed so the total size of the larger item is immediately visible.
- **FR-T05** Leaf durations accept only 5-60 minutes in 5-minute increments. Out-of-range values are rejected with a prompt to decompose.
- **FR-T06** Tasks can be reordered within the list. This order is a user-defined priority independent of placement.

### 5.2 Important and Slack Tasks

- **FR-I01** Users can designate a leaf task as important.
- **FR-I02** At most three distinct important tasks may be placed per day. A task split into multiple blocks counts once.
- **FR-I03** A fourth placement attempt is blocked and a swap dialog is shown. One of the existing three can be sent to the unplaced zone to make room.
- **FR-I04** Moving to another date decrements the original date's count and re-checks the target date. If the target already holds three, the move is blocked.
- **FR-S01** Users can designate a leaf task as a slack task. There is no count limit.
- **FR-S02** Slack tasks carry a 30-minute overrun allowance. This does not change occupied time on the plan lane; it functions only as an evaluation threshold.
- **FR-S03** An actual duration within `planned + 30 minutes` is treated as normal completion.
- **FR-S04** When a timer passes the planned duration, no overrun alert fires until the allowance is exhausted; the remaining allowance is displayed instead.
- **FR-S05** Slack tasks are aggregated separately in estimation-variance statistics.
- **FR-S06** The allowance is rendered as a translucent tail below the block. It occupies no time, so other blocks may be placed over it.

### 5.3 Commitments

- **FR-C01** Users can create, edit, and delete commitments.
- **FR-C02** Commitments may carry a recurrence rule and a validity period.
- **FR-C03** The weekly grid editor supports bulk entry of school timetables and similar schedules.
- **FR-C04** Individual instances can be cancelled or rescheduled, choosing "this date only" or "this and following."
- **FR-C05** Session-based commitments display remaining sessions, decrement on completion, and end recurrence at zero with a notification.
- **FR-C06** Commitments render as a background layer of the plan lane, visually distinct from blocks.
- **FR-C07** Drops onto commitment spans are rejected and marked as invalid during drag.
- **FR-C08** Commitments are also subject to actual logging. A timer may be run, or attendance recorded.
- **FR-C09** Recurrence is expanded at query time, limited to a one-year range.

### 5.4 Placement and Push-Down

**Interaction**

- **FR-P01** On desktop, placement is by drag and drop.
- **FR-P02** All platforms support **pick up → put down** two-step placement.
  - Tapping a task shows a "held item" bar at the top of the screen.
  - Tapping a time slot on the timeline places it there.
  - The held state persists across tab switches and scrolling.
  - Tapping elsewhere or the cancel button puts it back down.
- **FR-P03** Block height is proportional to duration. The true occupied size is visible during drag.
- **FR-P04** Drop positions snap to a 5-minute grid.
- **FR-P05** Placed blocks can be moved or resized via top/bottom handles, within 5-60 minutes.
- **FR-P06** On placement the system suggests a duration adjusted by the historical estimation variance for that task kind. The suggestion is prefilled but editable.

**Push-down algorithm**

Let `D` be the dropped block occupying `[s, e)`:

1. Collect the set `C` of plan-lane blocks overlapping `[s, e)`.
2. If `[s, e)` overlaps a commitment, **reject the drop entirely**.
3. Sort `C` by start time ascending.
4. Set a cursor at `e`. Reposition each block in `C` at the cursor in order, advancing the cursor to that block's end time.
5. If repositioning collides with a further block, append it to `C` and continue the chain.
6. Move a block and everything after it to the **unplaced zone** when:
   - The new position overlaps a commitment → `PUSHED_OUT`
   - The end time exceeds the sleep time → `SLEEP_BOUNDARY`
7. Commit the whole operation as one transaction and increment `DayVersion`.

- **FR-P07** A toast reports how many blocks moved and how many went to the unplaced zone. Displacement caused by the sleep boundary is stated explicitly.
- **FR-P08** The entire push-down result is reverted by a single undo. The client maintains at least 20 undo steps.
- **FR-P09** During drag, valid and invalid drop spans are distinguished in real time, and blocks that would be displaced are shown as translucent previews at their projected positions.

### 5.5 Unplaced Zone

- **FR-U01** The unplaced zone holds blocks that were pushed out, manually unplaced, or displaced by container conversion.
- **FR-U02** A "return to original slot" action retries placement at the previous position under the normal rules.
- **FR-U03** The system suggests the nearest open span that can accommodate the item.
- **FR-U04** Items can be moved to another date or returned to the task list.
- **FR-U05** Items remaining at day's end prompt for carry-over on first entry the next day. Nothing is deleted automatically.
- **FR-U06** A badge shows the item count on every screen when the zone is non-empty.

### 5.6 Actual Logging

- **FR-A01** Both timer-based and after-the-fact entry are supported.
- **FR-A02** A timer can be started from a planned block, a commitment, or an ad-hoc label.
- **FR-A03** Exactly one timer is active per user, enforced by the server-side `ActiveTimer`. Starting another automatically stops and commits the existing one.
- **FR-A04** Timers cannot be paused. Stopping ends the entry; restarting creates a new one.
- **FR-A05** On stop, duration rounds to the nearest 5 minutes. Entries under 5 minutes prompt for discard.
- **FR-A06** Exceeding the planned duration triggers an alert. Slack tasks follow FR-S04.
- **FR-A07** The timer start time is preserved locally so a network drop does not lose elapsed time; it is reconciled on recovery.
- **FR-A08** Tapping or dragging an empty span on the actual lane creates an entry directly.
- **FR-A09** A "went as planned" action copies a planned block into the actual lane, with times adjustable afterward.
- **FR-A10** At end of day, planned blocks and commitments with no actual record are gathered into a bulk review screen.
- **FR-A11** Actual entries can be freely edited and deleted.
- **FR-A12** Differences between plan and actual are visually emphasized — overrun, undershoot, not done, and unplanned activity are distinguished.
- **FR-A13** Overlapping actual entries are rendered side by side at reduced width.

### 5.7 Wake and Sleep

- **FR-D01** Users set default wake and sleep times in their profile.
- **FR-D02** Each date inherits the defaults and can be overridden individually.
- **FR-D03** Planned wake and sleep times define the placeable range for that date.
- **FR-D04** Actual wake and sleep times can be entered directly from markers at either end of the timeline.
- **FR-D05** The first timer start is suggested as the wake time and the last activity end as the sleep time. Nothing is saved until confirmed.
- **FR-D06** Sleep duration is derived from the previous day's actual sleep time and the current day's actual wake time.
- **FR-D07** Moving the sleep time earlier displaces blocks beyond it to the unplaced zone. Confirmation is required.
- **FR-D08** The timeline visually deactivates the spans before wake and after sleep.
- **FR-D09** The system does not provide a wake-up alarm. Users are directed to their device's native alarm app.

### 5.8 Available Time Budget

- **FR-B01** The system computes available time for each date.
  ```
  Day span      = sleep time - wake time
  Committed     = total length of the UNION of commitment intervals that day
                  (overlapping commitments counted once)
  Available     = day span - committed
  Placed        = sum of placed blocks        // blocks never overlap (R-01), so sum is exact
  Remaining     = available - placed
  ```
  `Committed` measures occupied wall-clock time, so overlapping commitments (§3.3) collapse into a single span. The union is computed over the query-time-expanded commitment instances, after applying `CommitmentException`.
- **FR-B02** Placed time against available time is shown as a budget bar, distinguishing committed, placed, and remaining.
- **FR-B03** Remaining time falling below zero triggers a warning but is not blocked. Only exceeding the sleep time is blocked, under R-08.
- **FR-B04** If the three important tasks together exceed available time, a warning is shown before placement.
- **FR-B05** Remaining time below 10% of the day span is flagged as an overloaded state.

### 5.9 Analytics

- **FR-N01** For each completed task, the ratio `actual / planned` is stored.
- **FR-N02** A median estimation multiplier is computed per task kind, weighted toward the most recent 30 records.
- **FR-N03** No suggestion is offered for a kind with fewer than 5 samples.
- **FR-N04** Daily summary — planned total, actual total, unplanned activity time, important tasks completed, unplaced count, sleep duration.
- **FR-N05** Weekly summary — estimation multiplier trend, share of unplanned activity, push-down frequency, execution rate against available time.
- **FR-N06** Labels of unplanned activities are aggregated by frequency, prompting recurring interruptions to be promoted to tasks or commitments.
- **FR-N07** Correlation between sleep duration and estimation accuracy is shown, once at least 30 days of samples exist.
- **FR-N08** Commitments are excluded from estimation-variance statistics, since their durations were not estimated by the user.

### 5.10 Notifications

#### 5.10.1 Principles

- **FR-R01** Notifications are a supplement. Core flows never assume delivery.
- **FR-R02** The system does not replace an alarm clock. Waking a locked device is out of scope.

#### 5.10.2 Three-Tier Fallback

- **FR-R03** **Foreground** — When the app is active, a local JS timer and Web Audio fire at the exact moment. No dependence on server push.
- **FR-R04** **Background** — When the app is inactive or the screen is off, delivery goes through Web Push.
- **FR-R05** **Recovery** — If a notification is missed, the next session shows a "missed blocks" screen for correcting the actual record. This flow is always available regardless of delivery success.
- **FR-R06** While a timer is active in the foreground, Screen Wake Lock prevents the display from sleeping. The user can disable this.

#### 5.10.3 Notification Types

| Type | Default | Timing |
|---|---|---|
| Block starting soon | On | 5 minutes before (configurable) |
| Block ended | On | At planned end time |
| Planned duration exceeded | On | When the timer passes the plan |
| Slack allowance exhausted | On | At planned + 30 minutes |
| Sleep time approaching | Off | 30 minutes before (configurable) |
| End-of-day review | Off | User-specified time |
| Sessions exhausted | On | When a session-based commitment reaches zero |

- **FR-R07** Each type can be toggled individually.
- **FR-R08** A do-not-disturb window can be set. Notifications within it are not sent.

#### 5.10.4 Multi-Device Handling

- **FR-R09** When several devices are subscribed, delivery goes to the one with the most recent `lastSeenAt` only.
- **FR-R10** Users can toggle notification delivery per device.
- **FR-R11** Subscriptions exceeding a consecutive-failure threshold are auto-disabled and the user is informed.

#### 5.10.5 No Auto-Advance

- **FR-R12** The system never auto-starts the next timer when a block ends. Auto-starting would log transit and rest as work, corrupting the actual record.
- **FR-R13** Notifications carry a "start next" action. On platforms without action buttons, tapping the notification opens the relevant screen.

---

## 6. Architecture

### 6.1 Composition

```
Browser / PWA (React SPA + Service Worker)
    ↓ HTTPS / JSON
Vercel Functions (dedicated API layer)
    ↓ Neon Serverless Driver
Neon PostgreSQL

External scheduler → (every minute) → /api/cron/notifications → Web Push
```

- **Hosting** Vercel. Frontend and API deploy as one project.
- **Database** Neon PostgreSQL.
- **API layer** Vercel Functions. A dedicated API is used rather than connecting directly through the Neon Data API.

### 6.2 Why a Dedicated API Layer

| Reason | Explanation |
|---|---|
| Transactional integrity | Push-down changes many blocks at once. Assembling this client-side leaves the plan broken on partial failure |
| Single enforcement point | R-01 through R-09 are validated in one place on the server |
| Fewer round trips | A single screen needs blocks, actuals, commitments, unplaced items, and markers together |
| Secret custody | VAPID private key and future external API keys stay server-side |
| Schema concealment | Table structure is not exposed to clients |
| Native extension | A future native client reuses the same endpoints |

### 6.3 Defense Layers

- **RLS** — `userId`-based policies on every table.
- **EXCLUDE constraint** — Block-vs-**block** non-overlap (the block half of R-01) enforced with `EXCLUDE USING gist` over `(userId, date, int4range(startMin, startMin + durationMin))`. Because `startMin` may exceed 1440 (§3.2), the range must not be modulo-1440. The database holds even if the API has a defect.
- **Block-vs-commitment** non-overlap (the other half of R-01, and FR-C07) is enforced **only** by API validation during placement, because recurring commitments are expanded at query time (§3.3) and are not rows the database can constrain. This is an accepted, explicit limitation: all writes go through the API layer (§6.2), so a bypassing write is not reachable in normal operation.
- **CHECK constraints** — Block `durationMin BETWEEN 5 AND 60`, `startMin >= 0 AND startMin % 5 = 0`. No upper-bound CHECK against `plannedSleepMin` (it lives in another row); that bound is enforced by the API under R-08.
- The three-important-tasks limit is handled in v1 by API validation under transaction isolation.

### 6.4 Key Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/days/{date}` | Blocks, expanded commitments, actuals, unplaced items, markers, and budget in one response |
| POST | `/api/blocks/place` | Placement. Server computes the push-down chain and commits one transaction |
| POST | `/api/blocks/{id}/move` | Move |
| DELETE | `/api/blocks/{id}` | Unplace → unplaced zone |
| POST | `/api/timer/start` \| `/stop` | Timer control |
| GET | `/api/timer` | Read active timer |
| GET | `/api/days/{date}/missed` | Missed-block recovery list |
| POST | `/api/push/subscribe` \| `/unsubscribe` | Push subscription management |
| GET | `/api/cron/notifications` | Scheduler only. Computes and sends due notifications |
| CRUD | `/api/tasks`, `/api/commitments`, `/api/actuals`, `/api/markers`, `/api/preferences` | Standard |
| GET | `/api/analytics/estimation` | Estimation multipliers by kind |

### 6.5 Authentication

- JWT-based. The API layer verifies the token, extracts `userId`, and applies it to every query.
- After re-authentication following session expiry, timer state is restored from the server-side `ActiveTimer`.

### 6.6 Connection Management

- Use the Neon serverless driver. Single queries go over HTTP mode; transactional placement operations use WebSocket mode or a pooled connection.
- Do not use a standard TCP driver directly from serverless functions; connections will be exhausted.

### 6.7 Notification Scheduler

- **FR-R14** The scheduler calls `/api/cron/notifications` once per minute.
- **FR-R15** That endpoint computes notifications due in the next one-minute window and sends them via Web Push, deriving them from `Block`, expanded `Commitment` instances, `ActiveTimer.expectedEndAt`, and `DayMarker`.
- **FR-R16** The endpoint requires `CRON_SECRET` authentication.
- **FR-R17** A delivery log prevents duplicate sends of the same notification.
- **NFR-C01** Vercel's built-in cron is not used: on the Hobby plan it runs once per day with hour-level imprecision. Either an external HTTP scheduler calls the API route, or the Pro plan's minute-level cron is used.
- **NFR-C02** The cron interval introduces up to 60 seconds of imprecision in push notifications. Notifications requiring exactness are handled by the foreground local timer in FR-R03.

---

## 7. PWA Requirements

- **NFR-P01** A web app manifest is provided and installability criteria are met.
- **NFR-P02** A service worker is registered and handles Push and Notification events.
- **NFR-P03** On iOS, push works only for web apps added to the Home Screen. The system detects whether an iOS session is in standalone mode and, if not, displays Add-to-Home-Screen guidance.
- **NFR-P04** Notification permission is requested only after an explicit user action, never on page load.
- **NFR-P05** All functionality works without notification permission. Notifications are supplementary.
- **NFR-P06** iOS may evict storage after disuse. No source-of-truth data is kept in the service worker cache.

---

## 8. Non-Functional Requirements

- **NFR-01** The system is online-only. Only the active timer's start time is held locally so elapsed time survives a network drop.
- **NFR-02** During a network outage, reads show the last fetched state and writes are blocked with a clear status indication.
- **NFR-03** Placement operations target a server response under 300 ms. The client responds immediately via optimistic UI.
- **NFR-04** Drag-and-drop and timeline scrolling maintain 60 fps.
- **NFR-05** All times are stored and displayed in the user's profile timezone. v1 does not support timezone travel.
- **NFR-06** Times are stored as minutes from midnight (Int) to minimize DST and timezone-transition effects.
- **NFR-07** Deletion is soft. Physical deletion occurs only on account deletion.
- **NFR-08** Full data export and import in JSON.
- **NFR-09** Scheduled automatic backups.
- **NFR-10** No performance degradation at 200 blocks per day per user across one year of data.
- **NFR-11** IDs are generated client-side as UUIDv7.

---

## 9. Multi-Device Synchronization

- **FR-Y01** Clients check for updates via `GET /api/days/{date}?since={version}`.
- **FR-Y02** A matching server version returns 304.
- **FR-Y03** Polling runs every 5 seconds in the foreground, stops in the background, and fires once immediately on focus.
- **FR-Y04** While a timer is active, timer state is polled alongside.
- **FR-Y05** Every state-changing request carries `expectedVersion`.
- **FR-Y06** A version mismatch returns 409 along with the current state.
- **FR-Y07** On 409 the client applies the latest state and reports "changed on another device." It does not retry automatically.
- **FR-Y08** The version granularity is the day. Push-down affects the whole day, so per-block versioning cannot detect the conflict.
- **FR-Y09** The timer is server state. The initiating device updates optimistically; others reflect it on the next poll.
- **FR-Y10** When a timer starts on another device, the previous device shows that it was stopped.

---

## 10. Design System

### 10.1 Brand Color

- The brand color is a **lime hue between yellow and green**, aligned with the product name's sense of "on, active."
- Lime has low contrast on light backgrounds, so it is used for **fills and accents only**, never for body text. Text uses a darkened variant.
- Defined as a scale with lightness steps to serve background, emphasis, and text variants.

### 10.2 Functional Colors

| Target | Direction |
|---|---|
| Normal task | Neutral gray |
| Important task | Brand lime, carrying the strongest visual weight |
| Slack task | Secondary brand tone. The allowance tail is the same color, translucent |
| Commitment | Desaturated blue-gray. Must recede as a background layer |
| Actual lane | Distinguished from the plan lane by saturation — plan vivid, actual muted |
| Warning (overload, overrun) | Warning color |
| Inactive (before wake, after sleep) | Neutral darker than the background |

- **FR-G01** Brand color, warning color, and commitment color maintain sufficient hue separation.
- **FR-G02** All text contrast meets WCAG AA.
- **FR-G03** Information is never conveyed by color alone. Task kinds are distinguished by shape or icon in addition to color.

### 10.3 Token Management

- **NFR-G01** Color, spacing, typography, and radius are defined as **platform-neutral design tokens**, not hardcoded in CSS.
- **NFR-G02** Tokens are maintained in a format directly reusable by a future native client.

---

## 11. Open Issues

| ID | Issue | Status |
|---|---|---|
| Q-01 | The three-important-tasks limit is placement-based, so a task completed without being placed is not counted. Is this loophole acceptable? | Open — before v1 release |
| Q-02 | Should the slack allowance of 30 minutes be user-configurable? A fixed value better matches the product philosophy | Open — schema forward-compatible via `Profile.slackAllowanceMin` (§3.0) |
| Q-03 | Recurrence expansion server-side or client-side? | **Resolved: server-side.** FR-C09 caps expansion to one year; §6 centralizes enforcement. Instances ship in `GET /api/days/{date}` |
| Q-04 | Date attribution for actual entries when sleep passes midnight | **Resolved: attribute by wake→sleep window** (§3.2, §3.5), on one continuous axis |
| Q-05 | Multi-user: account separation, or leave room for family sharing? | **Resolved: account separation only for v1.** Sharing is additive in v2 (a grant table over existing rows), so deferring costs nothing |
| Q-06 | External scheduling service versus Vercel Pro for the notification scheduler | Open — before deployment |
| Q-07 | Frontend framework and migration tooling selection | Open — before implementation |
| Q-08 | "This and following" reschedule (FR-C04) has no data model — `CommitmentException` is per-date only. Drop it from v1, or implement as a commitment split (`validUntil` + new row)? | Open — before implementing commitments |
| Q-09 | `actual/planned` grain for a task split across multiple blocks (FR-N01). Proposed: task-day grain (sum of actuals ÷ sum of planned blocks for the date) | Open — before analytics schema |
| Q-10 | What counts as "completion" for session decrement (FR-C05)? Proposed: an `ActualEntry` against the instance, deduplicated per instance | Open — before implementing commitments |

---

## 12. Roadmap

### 12.1 v1.1

- **One-time Google Calendar import** — Not continuous sync. The system lists recurring calendar events, and only those the user selects are copied into `Commitment` records. The link is then severed, eliminating webhooks, sync tokens, deletion detection, and conflict resolution.
  - Two-way sync is not under consideration. Blocks change dozens of times a day; writing them back would pollute the calendar and exhaust API quota.
  - All-day events are excluded from import. They would destroy available-time computation.
  - Calendar read access is a sensitive scope, so public distribution requires OAuth verification.
- Multi-day placement in the weekly view
- Automatic placement suggestions based on estimation multipliers

### 12.2 v2 — Native Extension

Only items genuinely impossible on the web are scoped to v2.

| Item | Why native is required |
|---|---|
| Home screen widget | Web apps cannot provide widgets |
| Live Activity / persistent notification | Keeping a timer visible on the lock screen |
| Precise local scheduled alarms | Device-scheduled, free of server tick imprecision |
| Focus-mode-breaking alerts | Native only |

**Premises**

- Native is not a replacement for the web app; it is a port of the **mobile execution surface only**. Planning and analytics stay on the web.
- The same API endpoints are reused. No server changes are required.
- Because `ActiveTimer` is server state, a widget can render from a read alone.
- Design tokens from §10.3 are reused directly.

**Entry condition** — Begin only after running v1 in real use long enough to confirm that the absence of widgets and Live Activities actually impedes usage.

### 12.3 Other v2

- Real-time sync (SSE or WebSocket)
- Smartwatch control — start/stop/next. A subset of the native app
