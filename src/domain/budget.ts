/** Available-time budget (SRS §5.8). */
import { unionLength } from './interval.js';

export interface BudgetInput {
  wakeMin: number;
  sleepMin: number;
  commitments: { startMin: number; durationMin: number }[];
  blocks: { durationMin: number }[];
}

export interface Budget {
  daySpan: number;
  committed: number;
  available: number;
  placed: number;
  remaining: number;
  /** FR-B05: remaining below 10% of the day span. */
  overloaded: boolean;
}

export function computeBudget(input: BudgetInput): Budget {
  const daySpan = input.sleepMin - input.wakeMin;
  // Union, not sum — commitments may overlap (§3.3).
  const committed = unionLength(
    input.commitments.map((c) => ({ start: c.startMin, end: c.startMin + c.durationMin })),
  );
  const available = daySpan - committed;
  const placed = input.blocks.reduce((sum, b) => sum + b.durationMin, 0);
  const remaining = available - placed;
  return {
    daySpan,
    committed,
    available,
    placed,
    remaining,
    overloaded: remaining < daySpan * 0.1,
  };
}
