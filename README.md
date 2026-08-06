# On

A personal timeboxing tool that combines a task list with a timeline. Plan your day as
non-overlapping blocks, log what you actually did in a separate lane, and let the
accumulating gap correct your time estimation. See [`docs/SRS.md`](docs/SRS.md) for the
full specification (v0.4).

## Stack

- **Client** — React SPA + service worker (PWA), Vite. *(not yet scaffolded)*
- **API** — Vercel Functions, a dedicated API layer. **(placement + day read implemented)**
- **Database** — Neon PostgreSQL, accessed with Drizzle ORM. **(schema applied and verified)**

## What exists today

| Layer | Path | Status |
|---|---|---|
| Schema + migrations | `migrations/`, `src/db/` | Applied to Neon, R-01 verified |
| Push-down algorithm (§5.4) | `src/domain/pushdown.ts` | Pure, covered by `npm run itest` |
| Recurrence expansion (§3.3) | `src/domain/recurrence.ts` | RRULE subset, server-side (Q-03) |
| Budget (§5.8) | `src/domain/budget.ts` | Union-based committed time |
| Services | `src/services/` | day read, placement, move, unplace, timer (R-03/R-08/versioning) |
| HTTP handlers | `api/` | day read, place, move/resize, unplace, timer start/stop/read |

### Endpoints

| Method | Path | Service |
|---|---|---|
| GET | `/api/days/{date}` | `getDay` — aggregate day read |
| POST | `/api/blocks/place` | `placeBlock` — new placement + push-down |
| POST | `/api/blocks/{id}/move` | `moveBlock` — move/resize (FR-P05) |
| DELETE | `/api/blocks/{id}` | `unplaceBlock` — to unplaced zone (R-05) |
| POST | `/api/timer/start` | `startTimer` — start, auto-commits any running timer (FR-A03) |
| POST | `/api/timer/stop` | `stopTimer` — commit to an actual entry (FR-A05 rounding) |
| GET | `/api/timer` | `getTimer` — read the active timer |
| GET / POST | `/api/tasks` | list · create (hierarchy + container/leaf rules, §3.1) |
| PATCH / DELETE | `/api/tasks/{id}` | edit (kind/estimate/status) · soft-delete |
| GET / POST | `/api/commitments` | list (filters) · create, or bulk grid entry (FR-C03) |
| PATCH / DELETE | `/api/commitments/{id}` | edit · soft-delete |
| POST | `/api/commitments/{id}/exceptions` | cancel / reschedule an instance (FR-C04) |

### Tests

- `npm test` — unit tests (Node's runner via tsx) for the pure domain: push-down,
  recurrence, budget, intervals, UUIDv7. No database needed.
- `npm run itest` — end-to-end integration test against the real database (creates a
  throwaway user, exercises the full placement/move/unplace surface, then cascades
  cleanup). Requires `DATABASE_URL`.

> **Auth is stubbed.** `api/_auth.ts` reads an `x-user-id` header as a placeholder; real
> JWT verification (§6.5) is not built yet and must land before any deployment.

## Database layer

The schema (SRS §3) is implemented as hand-written SQL migrations, with a typed Drizzle
mirror for query building.

| Path | Purpose |
|---|---|
| `migrations/*.sql` | **Source of truth.** Carries the gist EXCLUDE non-overlap constraint (R-01) and RLS policies (§6.3) that Drizzle cannot express |
| `src/db/schema.ts` | Typed table definitions for queries. Mirrors the SQL by hand |
| `src/db/client.ts` | Neon clients: HTTP-mode `db` (admin/cron only) and `withUser()` for RLS-scoped transactions |
| `scripts/migrate.ts` | Forward-only migration runner |

### Setup

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL from the Neon console
npm run db:migrate          # applies migrations/*.sql
```

Other scripts: `npm run typecheck`, `npm run db:studio` (Drizzle Studio).

### How RLS works here

Every tenant table has `FORCE ROW LEVEL SECURITY` with a policy keyed on
`current_setting('app.user_id')`. Because the policy is default-deny when that setting is
unset, **all tenant queries must go through `withUser(userId, tx => ...)`**, which opens a
transaction and sets `app.user_id` for its duration. The HTTP-mode `db` client has no such
context and is reserved for non-tenant work (health checks, the per-user cron loop).

Signup is the one privileged flow: it sets `app.user_id` to the *new* user's own id before
inserting the `users` row, so the policy's `WITH CHECK` passes.
