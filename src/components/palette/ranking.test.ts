import { describe, expect, it } from "vitest";
import { targetKey, type TargetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import type { Channel, Network, Query } from "@/types";
import { buildCandidates, type Candidate } from "./candidates";
import { fixtureState } from "./fixtures";
import { filterMatches, flatten, rankMatches, type FilterState } from "./ranking";

const network: Network = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  status: { state: "connected" },
  currentNick: "sable",
  sasl: { state: "notConfigured" },
  capsEnabled: [],
  lagMs: 42,
};

function channel(name: string, unread = 0): Channel {
  return {
    network: "libera",
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 3,
    unread,
    highlights: 0,
  };
}

function query(nick: string): Query {
  return { network: "libera", nick, account: null, unread: 0, online: true };
}

function stateWith(channels: string[], queries: string[] = [], recent: TargetKey[] = []): AppState {
  return {
    networks: { libera: network },
    networkOrder: ["libera"],
    channels: Object.fromEntries(channels.map((c) => [targetKey("libera", c), channel(c)])),
    queries: Object.fromEntries(queries.map((q) => [targetKey("libera", q), query(q)])),
    members: {},
    timelines: {},
    typing: {},
    replyTo: {},
    inputHistory: {},
    views: {},
    viewAnchor: {},
    consoleInput: {},
    rawAnchor: {},
    composerError: {},
    viewOrder: [],
    activeViewId: null,
    layout: null,
    recent,
    rosterHidden: {},
    paletteOpen: false,
    searchOpen: false,
    setup: null,
    pluginsOpen: false,
    uploadOpen: false,
    archiveOpen: false,
    appearanceOpen: false,
    plugins: [],
    pluginsUnavailable: null,
    collapsedNetworks: {},
    themes: [],
    brokenThemes: [],
    themeId: "ircx-dark",
    density: "comfortable",
    overrides: {},
    sidebarWidth: 240,
    rawLog: {},
    channelList: {},
    channelsOpen: null,
  };
}

function labels(candidates: Candidate[], query: string, recent: TargetKey[] = []): string[] {
  const state = filterMatches(candidates, query, null);
  return flatten(rankMatches(candidates, state, recent, 50)).map((r) => r.candidate.label);
}

describe("filterMatches", () => {
  const candidates = buildCandidates(stateWith(["#ctf-ops", "#ctf-web", "#linux"]));

  it("returns every candidate for an empty query", () => {
    expect(filterMatches(candidates, "", null).matches).toHaveLength(candidates.length);
  });

  it("narrows from the previous result when the query grows", () => {
    const prior = filterMatches(candidates, "ctf", null);
    const narrowed = filterMatches(candidates, "ctfo", prior);
    expect(narrowed.matches.length).toBeLessThan(prior.matches.length);
    expect(narrowed.matches).toEqual(filterMatches(candidates, "ctfo", null).matches);
  });

  it("rescans when the query is not an extension of the previous one", () => {
    const prior = filterMatches(candidates, "ctfo", null);
    const widened = filterMatches(candidates, "ctf", prior);
    expect(widened.matches).toEqual(filterMatches(candidates, "ctf", null).matches);
  });

  it("does not reuse a prior built from the empty query", () => {
    const prior: FilterState = filterMatches(candidates, "", null);
    expect(filterMatches(candidates, "l", prior).matches).toEqual(
      filterMatches(candidates, "l", null).matches,
    );
  });
});

describe("rankMatches", () => {
  it("finds #ctf-ops from ctfo", () => {
    const candidates = buildCandidates(
      stateWith(["#capture-the-flag-ops", "#ctf-ops", "#ctf-web", "#linux"]),
    );
    expect(labels(candidates, "ctfo")[0]).toBe("#ctf-ops");
  });

  it("breaks a score tie by recency", () => {
    const tied = buildCandidates(
      stateWith(["#ops-a", "#ops-b"], [], [targetKey("libera", "#ops-b")]),
    );
    expect(labels(tied, "ops", [targetKey("libera", "#ops-b")])[0]).toBe("#ops-b");
  });

  it("leaves a stronger match ahead of a recently visited weaker one", () => {
    const recent = [targetKey("libera", "#ops-elsewhere")];
    const candidates = buildCandidates(stateWith(["#ops", "#ops-elsewhere"], [], recent));
    expect(labels(candidates, "ops", recent)[0]).toBe("#ops");
  });

  it("orders recent targets first when there is no query", () => {
    const recent = [targetKey("libera", "#linux"), targetKey("libera", "#ctf-ops")];
    const candidates = buildCandidates(stateWith(["#ctf-ops", "#linux", "#rust"], [], recent));
    expect(labels(candidates, "", recent).slice(0, 2)).toEqual(["#linux", "#ctf-ops"]);
  });

  it("groups by kind", () => {
    const candidates = buildCandidates(stateWith(["#join-us"], ["joiner"]));
    const state = filterMatches(candidates, "join", null);
    const groups = rankMatches(candidates, state, [], 50);
    expect(groups.map((g) => g.kind)).toContain("channel");
    expect(groups.map((g) => g.kind)).toContain("command");
    for (const group of groups) {
      expect(group.results.every((r) => r.candidate.kind === group.kind)).toBe(true);
    }
  });

  it("reports highlight positions inside the label", () => {
    const candidates = buildCandidates(stateWith(["#ctf-ops"]));
    const state = filterMatches(candidates, "ctfo", null);
    const [top] = flatten(rankMatches(candidates, state, [], 10));
    expect(top?.positions).toEqual([1, 2, 3, 5]);
  });

  it("honours the limit", () => {
    const candidates = buildCandidates(stateWith(["#a1", "#a2", "#a3", "#a4"]));
    expect(flatten(rankMatches(candidates, filterMatches(candidates, "", null), [], 3))).toHaveLength(3);
  });
});

describe("frame budget", () => {
  const state = fixtureState();
  const recent = Object.keys(state.channels).slice(0, 30) as TargetKey[];

  it("has several thousand candidates", () => {
    expect(buildCandidates(state).length).toBeGreaterThan(4000);
  });

  // Scaling rather than milliseconds. The product goal is a frame, but a
  // wall-clock assertion measures whatever else the machine is doing: this
  // failed at 21ms on a box running a concurrent Rust build and passed on the
  // same commit when idle.
  //
  // A ratio was meant to survive that, and it does not on its own. Load does
  // not hit the two sample sizes equally: min-of-N filters contamination well
  // for a short run and badly for a long one, because a run four times as long
  // has four times the chance of catching a preemption. At five runs each, the
  // 4x workload is the contaminated side by a wide margin, and it is the
  // numerator. Hence three defences below, and a comment saying so rather than
  // a number nobody can account for.
  it("scales linearly in the number of candidates", { retry: 2 }, () => {
    const rank = (s: AppState) => () => {
      const candidates = buildCandidates(s);
      rankMatches(candidates, filterMatches(candidates, "", null), recent, 60);
    };
    const [small, large] = interleaved(12, rank(fixtureState(1000)), rank(fixtureState(4000)));

    // 4x the input. Linear lands near 4, quadratic near 16.
    expect(large / Math.max(small, 0.05)).toBeLessThan(8);
  });

  it("keeps each keystroke within a frame", () => {
    const candidates = buildCandidates(state);
    const best = fastest(3, () => {
      let prior = filterMatches(candidates, "c", null);
      for (const query of ["ct", "ctf", "ctfo", "ctfop"]) {
        prior = filterMatches(candidates, query, prior);
        rankMatches(candidates, prior, recent, 60);
      }
    });
    expect(best).toBeLessThan(16);
  });
});

/** Milliseconds for the quickest of `runs`, which is the honest figure for a
 * budget: a slow run on a loaded machine says nothing about the algorithm. */
function fastest(runs: number, work: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) best = Math.min(best, timed(work));
  return best;
}

/**
 * The quickest of each, measured alternately rather than one series after the
 * other. The load that perturbs a timing test arrives in bursts, and running
 * all of one workload and then all of the other lets a burst land entirely on
 * one side — which is the whole of what the ratio was supposed to rule out.
 */
function interleaved(runs: number, a: () => void, b: () => void): [number, number] {
  let bestA = Infinity;
  let bestB = Infinity;
  for (let i = 0; i < runs; i++) {
    bestA = Math.min(bestA, timed(a));
    bestB = Math.min(bestB, timed(b));
  }
  return [bestA, bestB];
}

function timed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}
