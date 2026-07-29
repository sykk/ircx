import { NO_MATCH, canMatch, matchPositions, queryMask, scoreMatch } from "@/lib/fuzzy";
import type { TargetKey } from "@/store/keys";
import { KIND_ORDER, type Candidate, type CandidateKind } from "./candidates";

export interface Match {
  /** Index into the candidate array `filterMatches` was given. */
  index: number;
  score: number;
}

export interface FilterState {
  /** Lowercased and trimmed. */
  query: string;
  matches: Match[];
}

export interface RankedResult {
  candidate: Candidate;
  score: number;
  positions: number[];
}

export interface RankedGroup {
  kind: CandidateKind;
  results: RankedResult[];
}

/** Scores `query` against the candidates that survived `prior`.
 *
 * Adding a character can only remove matches, never add one, so each keystroke
 * rescores the previous survivors instead of the whole list. Backspacing or
 * pasting invalidates that, and the caller passes `null` to start over. */
export function filterMatches(
  candidates: Candidate[],
  rawQuery: string,
  prior: FilterState | null,
): FilterState {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") {
    return { query, matches: candidates.map((_, index) => ({ index, score: 0 })) };
  }

  const reusable = prior && prior.query !== "" && query.startsWith(prior.query);
  const mask = queryMask(query);
  const matches: Match[] = [];

  const consider = (index: number) => {
    const candidate = candidates[index];
    if (!candidate || !canMatch(mask, candidate.hay)) return;
    const score = scoreMatch(query, candidate.hay);
    if (score > NO_MATCH) matches.push({ index, score });
  };

  if (reusable) for (const m of prior.matches) consider(m.index);
  else for (let i = 0; i < candidates.length; i++) consider(i);

  return { query, matches };
}

/** Best first, then most recently visited, then by kind, then shortest label.
 *
 * Recency only separates equal scores: the issue asks for visited targets above
 * unvisited ones, not for a visited target to outrank a better name match. */
export function rankMatches(
  candidates: Candidate[],
  state: FilterState,
  recent: readonly TargetKey[],
  limit: number,
): RankedGroup[] {
  const recency = new Map<TargetKey, number>();
  recent.forEach((key, i) => recency.set(key, i));
  const rankOf = (c: Candidate) =>
    c.key === null ? Number.MAX_SAFE_INTEGER : (recency.get(c.key) ?? Number.MAX_SAFE_INTEGER);

  const ordered = state.matches.slice().sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ca = candidates[a.index]!;
    const cb = candidates[b.index]!;
    const ra = rankOf(ca);
    const rb = rankOf(cb);
    if (ra !== rb) return ra - rb;
    if (ca.kind !== cb.kind) return KIND_ORDER[ca.kind] - KIND_ORDER[cb.kind];
    if (ca.label.length !== cb.label.length) return ca.label.length - cb.label.length;
    // Code-unit order, not locale order: this runs thousands of times per
    // keystroke and only decides between labels that tied on everything else.
    return ca.label < cb.label ? -1 : ca.label > cb.label ? 1 : 0;
  });

  const groups: RankedGroup[] = [];
  const byKind = new Map<CandidateKind, RankedGroup>();

  for (const match of ordered.slice(0, limit)) {
    const candidate = candidates[match.index]!;
    let group = byKind.get(candidate.kind);
    if (!group) {
      group = { kind: candidate.kind, results: [] };
      byKind.set(candidate.kind, group);
      groups.push(group);
    }
    group.results.push({
      candidate,
      score: match.score,
      // Only the rows about to render pay for the backtrack.
      positions: state.query === "" ? [] : matchPositions(state.query, candidate.hay),
    });
  }

  return groups;
}

export function flatten(groups: RankedGroup[]): RankedResult[] {
  return groups.flatMap((g) => g.results);
}
