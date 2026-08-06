/**
 * Query-time recurrence expansion (SRS §3.3, Q-03 resolved server-side).
 *
 * Supported RRULE subset (v1): FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (weekly),
 * COUNT, UNTIL. Plus validFrom/validUntil bounds and CommitmentException overrides.
 *
 * Known limitations, matching the SRS subset: WKST is fixed to Monday; MONTHLY matches
 * the day-of-month of validFrom (BYDAY/BYMONTHDAY for monthly is not supported).
 * All date math is UTC on 'YYYY-MM-DD' strings to stay timezone-agnostic (NFR-06).
 */

const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface CommitmentLike {
  id: string;
  title: string;
  category: string;
  color: string;
  startMin: number;
  durationMin: number;
  recurrence: string | null;
  validFrom: string;
  validUntil: string | null;
}

export interface ExceptionLike {
  commitmentId: string;
  date: string;
  type: 'CANCELLED' | 'MODIFIED';
  startMin: number | null;
  durationMin: number | null;
}

export interface CommitmentInstance {
  commitmentId: string;
  title: string;
  category: string;
  color: string;
  startMin: number;
  durationMin: number;
}

interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  count?: number;
  until?: string; // 'YYYY-MM-DD'
  byday?: string[];
}

const VALID_BYDAY = new Set(WEEKDAY);
const VALID_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY']);

/**
 * Validate an RRULE against the supported v1 subset (§3.3). Returns the first problem
 * found. Used at commitment write time so unsupported rules are rejected up front rather
 * than silently mis-expanded.
 */
export function validateRRule(rrule: string): { ok: true } | { ok: false; error: string } {
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(';')) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined || v === '') return { ok: false, error: `malformed segment "${kv}"` };
    parts[k.toUpperCase()] = v;
  }
  if (!parts.FREQ) return { ok: false, error: 'FREQ is required' };
  if (!VALID_FREQ.has(parts.FREQ)) return { ok: false, error: `unsupported FREQ "${parts.FREQ}"` };
  if (parts.INTERVAL !== undefined && !(Number(parts.INTERVAL) >= 1))
    return { ok: false, error: 'INTERVAL must be a positive integer' };
  if (parts.COUNT !== undefined && !(Number(parts.COUNT) >= 1))
    return { ok: false, error: 'COUNT must be a positive integer' };
  if (parts.UNTIL !== undefined && !/^\d{8}(T\d{6}Z?)?$/.test(parts.UNTIL))
    return { ok: false, error: 'UNTIL must be YYYYMMDD[THHMMSSZ]' };
  if (parts.BYDAY !== undefined) {
    for (const d of parts.BYDAY.split(','))
      if (!VALID_BYDAY.has(d as (typeof WEEKDAY)[number]))
        return { ok: false, error: `unsupported BYDAY "${d}"` };
    if (parts.FREQ === 'MONTHLY') return { ok: false, error: 'BYDAY with MONTHLY is not supported in v1' };
  }
  return { ok: true };
}

// --- date helpers (UTC, on 'YYYY-MM-DD') ---
const toEpochDay = (d: string): number => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, day) / 86_400_000);
};
const fromEpochDay = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);
const diffDays = (a: string, b: string): number => toEpochDay(b) - toEpochDay(a);
const weekdayCode = (d: string): string => WEEKDAY[new Date(toEpochDay(d) * 86_400_000).getUTCDay()]!;
const dayOfMonth = (d: string): number => Number(d.slice(8, 10));
const mondayOnOrBefore = (d: string): string => {
  const wd = new Date(toEpochDay(d) * 86_400_000).getUTCDay(); // 0=Sun..6=Sat
  return fromEpochDay(toEpochDay(d) - ((wd + 6) % 7));
};
const monthsBetween = (a: string, b: string): number =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 +
  (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

function parseRule(rrule: string): ParsedRule {
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(';')) {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const until = parts.UNTIL
    ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
    : undefined;
  return {
    freq: (parts.FREQ as ParsedRule['freq']) ?? 'DAILY',
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    count: parts.COUNT ? Number(parts.COUNT) : undefined,
    until,
    byday: parts.BYDAY ? parts.BYDAY.split(',') : undefined,
  };
}

/** Whether the commitment's rule fires on `date`, ignoring COUNT and exceptions. */
function baseOccurs(c: CommitmentLike, rule: ParsedRule | null, date: string): boolean {
  if (diffDays(c.validFrom, date) < 0) return false;
  if (c.validUntil && date > c.validUntil) return false;
  if (!rule) return date === c.validFrom; // one-off
  if (rule.until && date > rule.until) return false;

  switch (rule.freq) {
    case 'DAILY':
      return diffDays(c.validFrom, date) % rule.interval === 0;
    case 'WEEKLY': {
      const byday = rule.byday ?? [weekdayCode(c.validFrom)];
      if (!byday.includes(weekdayCode(date))) return false;
      const weekIdx = Math.floor(diffDays(mondayOnOrBefore(c.validFrom), date) / 7);
      return weekIdx % rule.interval === 0;
    }
    case 'MONTHLY':
      if (dayOfMonth(date) !== dayOfMonth(c.validFrom)) return false;
      return monthsBetween(c.validFrom, date) % rule.interval === 0;
  }
}

/** Whether the commitment occurs on `date`, honoring COUNT (but not exceptions). */
export function occursOn(c: CommitmentLike, date: string): boolean {
  const rule = c.recurrence ? parseRule(c.recurrence) : null;
  if (!baseOccurs(c, rule, date)) return false;
  if (rule?.count != null) {
    let n = 0;
    for (let e = toEpochDay(c.validFrom); e <= toEpochDay(date); e++) {
      if (baseOccurs(c, rule, fromEpochDay(e)) && ++n > rule.count) return false;
    }
  }
  return true;
}

/**
 * Expand a set of commitments to their concrete instances on a single date,
 * applying CANCELLED / MODIFIED exceptions (§3.3).
 */
export function expandOnDate(
  commitments: CommitmentLike[],
  exceptions: ExceptionLike[],
  date: string,
): CommitmentInstance[] {
  const out: CommitmentInstance[] = [];
  for (const c of commitments) {
    if (!occursOn(c, date)) continue;
    const ex = exceptions.find((e) => e.commitmentId === c.id && e.date === date);
    if (ex?.type === 'CANCELLED') continue;
    out.push({
      commitmentId: c.id,
      title: c.title,
      category: c.category,
      color: c.color,
      startMin: ex?.startMin ?? c.startMin,
      durationMin: ex?.durationMin ?? c.durationMin,
    });
  }
  return out;
}
