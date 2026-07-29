/* Fuzzy subsequence matching for the command palette.
 *
 * The algorithm is the two-matrix alignment fzy uses: for every prefix of the
 * query it tracks the best score that ends in a match at each candidate
 * position, so the reported score is the best alignment rather than the first
 * one found left to right. `to` against `#ctf-tools` scores the `to` in
 * `tools`, not the `t` in `ctf` and a later `o`.
 *
 * Weights are ordered so that, for the same query, a candidate ranks in this
 * order: run starting at the head of the string, run starting after a
 * separator, run continuing an earlier match, isolated scattered characters.
 * Gaps subtract, and an inner gap costs more than a leading or trailing one,
 * which is what puts `#ctf-ops` above `#capture-the-flag-ops` for `ctfo`.
 */

const BONUS_HEAD = 16;
const BONUS_BOUNDARY = 12;
const BONUS_CAMEL = 8;
const BONUS_CONSECUTIVE = 12;
const GAP_LEADING = -1;
const GAP_INNER = -3;
const GAP_TRAILING = -1;

/** Finite stand-in for -Infinity so the tables can be Int32Array. */
export const NO_MATCH = -1_000_000;

const SEPARATORS = new Set([" ", "-", "_", ".", "/", "\\", ",", ":", "#", "&", "+", "!", "@"]);

/** A candidate string with everything the inner loop would otherwise recompute. */
export interface Haystack {
  text: string;
  lower: string;
  /** Score awarded to a match landing on each position. */
  bonus: Int32Array;
  /** One bit per distinct letter. See `queryMask`. */
  mask: number;
}

export function prepare(text: string): Haystack {
  const lower = text.toLowerCase();
  const bonus = new Int32Array(lower.length);
  let mask = 0;

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]!;
    mask |= charBit(ch);

    if (i === 0) {
      bonus[i] = BONUS_HEAD;
      continue;
    }
    const prev = lower[i - 1]!;
    if (SEPARATORS.has(prev)) bonus[i] = BONUS_BOUNDARY;
    else if (text[i] !== ch && text[i - 1] === prev) bonus[i] = BONUS_CAMEL;
  }

  return { text, lower, bonus, mask };
}

/** Bits for the letters in `query`. A candidate whose mask is missing any of
 * them cannot contain the query as a subsequence, which rejects most of a large
 * candidate list with one integer test instead of an alignment. */
export function queryMask(query: string): number {
  let mask = 0;
  for (let i = 0; i < query.length; i++) mask |= charBit(query[i]!);
  return mask;
}

export function canMatch(mask: number, hay: Haystack): boolean {
  return (mask & ~hay.mask) === 0;
}

/** Rows are reused across candidates; the palette scores thousands per
 * keystroke and the allocations dominated otherwise. */
let rowMatch = new Int32Array(0);
let rowBest = new Int32Array(0);
let prevMatch = new Int32Array(0);
let prevBest = new Int32Array(0);

function ensureRows(width: number) {
  if (rowMatch.length >= width) return;
  rowMatch = new Int32Array(width);
  rowBest = new Int32Array(width);
  prevMatch = new Int32Array(width);
  prevBest = new Int32Array(width);
}

/** `query` must already be lowercase. Returns `NO_MATCH` when it is not a
 * subsequence of the candidate. */
export function scoreMatch(query: string, hay: Haystack): number {
  const n = query.length;
  const m = hay.lower.length;
  if (n === 0) return 0;
  if (n > m) return NO_MATCH;

  ensureRows(m);
  let match = rowMatch;
  let best = rowBest;
  let lastMatch = prevMatch;
  let lastBest = prevBest;

  for (let i = 0; i < n; i++) {
    const qc = query[i]!;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    let running = NO_MATCH;

    for (let j = 0; j < m; j++) {
      if (qc === hay.lower[j]) {
        let score = NO_MATCH;
        if (i === 0) {
          score = j * GAP_LEADING + hay.bonus[j]!;
        } else if (j > 0) {
          score = Math.max(
            step(lastBest[j - 1]!, hay.bonus[j]!),
            step(lastMatch[j - 1]!, BONUS_CONSECUTIVE),
          );
        }
        match[j] = score;
        running = Math.max(score, step(running, gap));
      } else {
        match[j] = NO_MATCH;
        running = step(running, gap);
      }
      best[j] = running;
    }

    [match, lastMatch] = [lastMatch, match];
    [best, lastBest] = [lastBest, best];
  }

  return lastBest[m - 1]!;
}

/** Keeps NO_MATCH absorbing: a bonus applied to an impossible alignment must
 * not turn it into a merely bad one. */
function step(score: number, delta: number): number {
  return score <= NO_MATCH ? NO_MATCH : score + delta;
}

/** Candidate indices the winning alignment matched, ascending. Empty when
 * there is no match. Allocates, so call it only for rows about to render. */
export function matchPositions(query: string, hay: Haystack): number[] {
  const n = query.length;
  const m = hay.lower.length;
  if (n === 0 || n > m) return [];

  const match = new Int32Array(n * m);
  const best = new Int32Array(n * m);

  for (let i = 0; i < n; i++) {
    const qc = query[i]!;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    const row = i * m;
    const prev = row - m;
    let running = NO_MATCH;

    for (let j = 0; j < m; j++) {
      if (qc === hay.lower[j]) {
        let score = NO_MATCH;
        if (i === 0) {
          score = j * GAP_LEADING + hay.bonus[j]!;
        } else if (j > 0) {
          score = Math.max(
            step(best[prev + j - 1]!, hay.bonus[j]!),
            step(match[prev + j - 1]!, BONUS_CONSECUTIVE),
          );
        }
        match[row + j] = score;
        running = Math.max(score, step(running, gap));
      } else {
        match[row + j] = NO_MATCH;
        running = step(running, gap);
      }
      best[row + j] = running;
    }
  }

  if (best[n * m - 1]! <= NO_MATCH) return [];

  const positions = new Array<number>(n);
  let j = m - 1;
  // A match that only scored because it continued a run forces the previous
  // query character onto the preceding position, so the run stays contiguous.
  let inRun = false;

  for (let i = n - 1; i >= 0; i--) {
    const row = i * m;
    for (; j >= 0; j--) {
      const here = match[row + j]!;
      if (here === NO_MATCH) continue;
      if (!inRun && here !== best[row + j]!) continue;
      inRun =
        i > 0 && j > 0 && here === match[row - m + j - 1]! + BONUS_CONSECUTIVE;
      positions[i] = j--;
      break;
    }
  }

  return positions;
}

function charBit(ch: string): number {
  const code = ch.charCodeAt(0) - 97;
  return code >= 0 && code < 26 ? 1 << code : 1 << 26;
}
