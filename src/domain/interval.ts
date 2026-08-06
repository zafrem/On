/** Half-open interval helpers over minutes-from-midnight. */

/** True when [a1,a2) and [b1,b2) overlap (touching endpoints do not count). */
export const overlaps = (a1: number, a2: number, b1: number, b2: number): boolean =>
  a1 < b2 && b1 < a2;

/**
 * Total length covered by the union of a set of intervals, counting overlapping
 * spans once (SRS §5.8 — commitments may overlap, so `Committed` is a union).
 */
export function unionLength(intervals: { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  return total + (curEnd - curStart);
}
