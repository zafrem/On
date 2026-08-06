/**
 * Push-down algorithm (SRS §5.4). Pure and deterministic: given a drop and the
 * current day, it returns where each block ends up. No I/O — the caller applies the
 * result inside one transaction (R-07) and increments DayVersion.
 *
 * Let D be the dropped block occupying [s, e):
 *   1. Collect C = plan-lane blocks overlapping [s, e).
 *   2. If [s, e) overlaps a commitment, reject the drop entirely.
 *   3. Sort C by start ascending.
 *   4. cursor = e. Reposition each block in C at the cursor, advancing to its end.
 *   5. If a repositioned block collides with a further block, append it to C.
 *   6. A block (and everything after it) goes to the unplaced zone when its new
 *      position overlaps a commitment (PUSHED_OUT) or exceeds sleep (SLEEP_BOUNDARY).
 * R-08 (the drop itself before wake / after sleep) is a rejection, not a push.
 */
import { overlaps } from './interval.js';

export interface PlacedBlock {
  id: string;
  startMin: number;
  durationMin: number;
}
export interface FixedInterval {
  startMin: number;
  durationMin: number;
}

export type RejectReason = 'OUT_OF_DAY' | 'COMMITMENT_OVERLAP';

export interface Reposition {
  id: string;
  newStartMin: number;
}
export interface UnplacedMove {
  id: string;
  reason: 'PUSHED_OUT' | 'SLEEP_BOUNDARY';
  originStartMin: number;
  durationMin: number;
}

export type PushDownResult =
  | { ok: false; reason: RejectReason }
  | { ok: true; repositions: Reposition[]; unplaced: UnplacedMove[] };

export interface PushDownInput {
  dropped: { startMin: number; durationMin: number };
  /** Live plan-lane blocks for the day, excluding the block being moved (if any). */
  existing: PlacedBlock[];
  /** Immovable commitment instances for the day (already expanded). */
  commitments: FixedInterval[];
  wakeMin: number;
  sleepMin: number;
}

const hitsCommitment = (start: number, end: number, commitments: FixedInterval[]): boolean =>
  commitments.some((c) => overlaps(start, end, c.startMin, c.startMin + c.durationMin));

export function pushDown(input: PushDownInput): PushDownResult {
  const { dropped, existing, commitments, wakeMin, sleepMin } = input;
  const s = dropped.startMin;
  const e = s + dropped.durationMin;

  // R-08: the drop must lie within the day.
  if (s < wakeMin || e > sleepMin) return { ok: false, reason: 'OUT_OF_DAY' };
  // Step 2: never displace a commitment.
  if (hitsCommitment(s, e, commitments)) return { ok: false, reason: 'COMMITMENT_OVERLAP' };

  const inChain = new Set<string>();
  // Step 1 + 3: blocks overlapping the drop, sorted ascending.
  const chain: PlacedBlock[] = existing
    .filter((b) => overlaps(s, e, b.startMin, b.startMin + b.durationMin))
    .sort((a, b) => a.startMin - b.startMin);
  chain.forEach((b) => inChain.add(b.id));

  const repositions: Reposition[] = [];
  const unplaced: UnplacedMove[] = [];

  let cursor = e;
  for (let i = 0; i < chain.length; i++) {
    const b = chain[i]!;
    const newStart = cursor;
    const newEnd = cursor + b.durationMin;

    // Step 6: obstacle terminates the chain — this block and all after it spill.
    const reason: UnplacedMove['reason'] | null =
      newEnd > sleepMin ? 'SLEEP_BOUNDARY' : hitsCommitment(newStart, newEnd, commitments) ? 'PUSHED_OUT' : null;
    if (reason) {
      for (let j = i; j < chain.length; j++) {
        const u = chain[j]!;
        unplaced.push({ id: u.id, reason, originStartMin: u.startMin, durationMin: u.durationMin });
      }
      break;
    }

    repositions.push({ id: b.id, newStartMin: newStart });
    cursor = newEnd;

    // Step 5: the new position may collide with blocks not yet in the chain.
    for (const x of existing) {
      if (inChain.has(x.id)) continue;
      if (overlaps(newStart, newEnd, x.startMin, x.startMin + x.durationMin)) {
        chain.push(x);
        inChain.add(x.id);
      }
    }
    // Keep the not-yet-processed tail ordered by original start.
    const tail = chain.slice(i + 1).sort((a, b) => a.startMin - b.startMin);
    chain.splice(i + 1, chain.length - (i + 1), ...tail);
  }

  return { ok: true, repositions, unplaced };
}
