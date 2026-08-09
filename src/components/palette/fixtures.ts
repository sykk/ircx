import { DEFAULT_PRESENTATION, DEFAULT_TYPOGRAPHY } from "@/lib/theme";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import type { Channel, Network, Query } from "@/types";

/* Synthetic store contents for the palette's tests. No backend exists yet, and
 * the palette's stated budget is one frame with several thousand targets, so
 * the perf test needs a list that size with names that actually collide. */

const HEADS = [
  "ctf", "pwn", "web", "crypto", "rev", "forensics", "osint", "hack", "sec", "net",
  "linux", "bsd", "rust", "python", "go", "zig", "c", "asm", "kernel", "embedded",
  "ops", "infra", "sre", "dev", "qa", "docs", "design", "off", "meta", "social",
];

const TAILS = [
  "ops", "team", "chat", "help", "dev", "news", "general", "lounge", "lab", "war",
  "notes", "pings", "bots", "log", "triage", "review", "planning", "random", "300", "42",
];

const NICKS = [
  "sable", "phrack", "marrow", "nyx", "kade", "wren", "jolt", "spiral", "rzz", "fox",
  "bitwise", "cinder", "pwn", "vex", "quill", "atlas", "meridian", "cobalt",
];

/** Small deterministic PRNG so a failing perf run reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export function fixtureState(channelCount = 4000, networkCount = 12): AppState {
  const random = rng(0x1c7f);
  const networks: Record<string, Network> = {};
  const networkOrder: string[] = [];
  const channels: Record<string, Channel> = {};
  const queries: Record<string, Query> = {};

  for (let n = 0; n < networkCount; n++) {
    const id = `net${n}`;
    networkOrder.push(id);
    networks[id] = {
      id,
      name: `Network ${n}`,
      host: `irc.net${n}.example`,
      port: 6697,
      tls: true,
      status: { state: "connected" },
      currentNick: "sable",
      sasl: { state: "notConfigured" },
      capsEnabled: [],
      lagMs: 42,
    };
  }

  const seen = new Set<string>();
  let made = 0;
  for (let i = 0; made < channelCount; i++) {
    const network = networkOrder[i % networkCount]!;
    const head = HEADS[Math.floor(random() * HEADS.length)]!;
    const tail = TAILS[Math.floor(random() * TAILS.length)]!;
    const name = `#${head}-${tail}${made % 7 === 0 ? `-${made}` : ""}`;
    const key = targetKey(network, name);
    if (seen.has(key)) continue;
    seen.add(key);
    made++;
    channels[key] = {
      network,
      name,
      topic: null,
      modes: "+nt",
      joined: true,
      memberCount: 12,
      unread: made % 11 === 0 ? made % 40 : 0,
      highlights: 0,
    };
  }

  for (let i = 0; i < NICKS.length * networkCount; i++) {
    const network = networkOrder[i % networkCount]!;
    const nick = `${NICKS[i % NICKS.length]!}${i < NICKS.length ? "" : i}`;
    queries[targetKey(network, nick)] = {
      network,
      nick,
      account: null,
      unread: i % 5 === 0 ? 3 : 0,
      online: true,
    };
  }

  return {
    networks,
    networkOrder,
    channels,
    queries,
    members: {},
    inputHistory: {},
    timelines: {},
    typing: {},
    replyTo: {},
    views: {},
    viewAnchor: {},
    consoleInput: {},
    rawAnchor: {},
    composerError: {},
    viewOrder: [],
    activeViewId: null,
    layout: null,
    recent: [],
    rosterHidden: {},
    paletteOpen: false,
    searchOpen: false,
    setup: null,
    uploadRequest: null,
    plugins: [],
    pluginsUnavailable: null,
    collapsedNetworks: {},
    themes: [],
    brokenThemes: [],
    themeId: "ircx-dark",
    density: "comfortable",
    presentation: DEFAULT_PRESENTATION,
    typography: DEFAULT_TYPOGRAPHY,
    overrides: {},
    sidebarWidth: 240,
    rosterWidth: null,
    rawLog: {},
    channelList: {},
    channelsOpen: null,
  };
}
