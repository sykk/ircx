import { describe, expect, it } from "vitest";
import { NO_MATCH, canMatch, matchPositions, prepare, queryMask, scoreMatch } from "./fuzzy";

function score(query: string, text: string): number {
  return scoreMatch(query.toLowerCase(), prepare(text));
}

function positions(query: string, text: string): number[] {
  return matchPositions(query.toLowerCase(), prepare(text));
}

/** Best-first, the way the palette lists them. */
function rank(query: string, texts: string[]): string[] {
  return texts
    .map((text) => ({ text, score: score(query, text) }))
    .filter((r) => r.score > NO_MATCH)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.text);
}

describe("scoreMatch", () => {
  it("matches a scattered subsequence", () => {
    expect(score("ctfo", "#ctf-ops")).toBeGreaterThan(NO_MATCH);
  });

  it("rejects a query that is not a subsequence", () => {
    expect(score("xyz", "#ctf-ops")).toBe(NO_MATCH);
    expect(score("cft", "#ctf-ops")).toBe(NO_MATCH);
  });

  it("rejects a query longer than the candidate", () => {
    expect(score("channels", "#ctf")).toBe(NO_MATCH);
  });

  it("scores the empty query as neutral", () => {
    expect(score("", "#ctf-ops")).toBe(0);
  });

  it("ignores case", () => {
    expect(score("ctf", "#CTF-Ops")).toBe(score("ctf", "#ctf-ops"));
  });

  it("puts a prefix run above a scattered match", () => {
    expect(score("ctf", "#ctf-ops")).toBeGreaterThan(score("ctf", "#capture-the-flag"));
  });

  it("puts a word-boundary hit above a mid-word one", () => {
    expect(score("op", "#ctf-ops")).toBeGreaterThan(score("op", "#cooperate"));
  });

  it("prefers the shorter candidate when both are prefix runs", () => {
    expect(score("ctf", "#ctf")).toBeGreaterThan(score("ctf", "#ctf-operations"));
  });

  it("finds the best alignment, not the leftmost one", () => {
    // The leftmost `t` is in `ctf`; the run in `tools` scores higher.
    expect(positions("to", "#ctf-tools")).toEqual([5, 6]);
  });
});

describe("ranking", () => {
  it("orders #ctf-ops first for ctfo", () => {
    const order = rank("ctfo", [
      "#capture-the-flag-ops",
      "#ctf-ops",
      "#ctf-web",
      "#cats-forum",
      "#linux",
    ]);
    expect(order[0]).toBe("#ctf-ops");
    expect(order).not.toContain("#ctf-web");
    expect(order).not.toContain("#linux");
  });

  it("orders an exact channel above one that merely contains it", () => {
    expect(rank("ops", ["#ctf-ops", "#opers", "#ops"])[0]).toBe("#ops");
  });

  it("ranks initials of hyphenated words above a mid-word run", () => {
    expect(rank("cw", ["#ctf-web", "#crew"])[0]).toBe("#ctf-web");
  });
});

describe("matchPositions", () => {
  it("reports every matched index in order", () => {
    expect(positions("ctfo", "#ctf-ops")).toEqual([1, 2, 3, 5]);
  });

  it("keeps a contiguous run contiguous", () => {
    expect(positions("ops", "#ctf-ops")).toEqual([5, 6, 7]);
  });

  it("returns nothing when there is no match", () => {
    expect(positions("xyz", "#ctf-ops")).toEqual([]);
  });

  it("agrees with the score on which characters matched", () => {
    const hay = prepare("#ctf-ops");
    expect(positions("cto", "#ctf-ops")).toHaveLength(3);
    expect(scoreMatch("cto", hay)).toBeGreaterThan(NO_MATCH);
  });
});

describe("queryMask", () => {
  it("rejects a candidate missing one of the query letters", () => {
    expect(canMatch(queryMask("ctfo"), prepare("#ctf-ops"))).toBe(true);
    expect(canMatch(queryMask("ctfz"), prepare("#ctf-ops"))).toBe(false);
  });

  it("never rejects on characters it does not track", () => {
    expect(canMatch(queryMask("300"), prepare("#pwn-300"))).toBe(true);
  });
});
