import type { Channel, Member, Network } from "@/types";

/* Stand-ins for a backend that does not exist yet. Nothing here is imported by
 * a component; tests are the only consumer. */

export function member(nick: string, extra: Partial<Member> = {}): Member {
  return { nick, account: null, prefixes: [], away: null, ...extra };
}

/** The member list from `docs/mockup.png`, plus the two cases the mockup cannot
 * show: a founder carrying several prefixes, and a nick with no account. */
export const CTF_OPS_MEMBERS: Member[] = [
  member("sable", { account: "sable", prefixes: ["@"] }),
  member("bitwise", { account: "bitwise", prefixes: ["@"] }),
  member("nyx", { account: "nyx", prefixes: ["@"], away: "" }),
  member("Ariel", { account: "ariel", prefixes: ["~", "@", "+"] }),
  member("phrack", { account: "phrack", prefixes: ["+"] }),
  member("marrow", { account: "marrow", prefixes: ["+"] }),
  member("halcyon", { prefixes: ["%"] }),
  member("cinder", { account: "cinder" }),
  member("kade", { account: "kade" }),
  member("wren", { account: "wren", away: "sleep" }),
  member("jolt", { account: "jolt" }),
  member("pwn-300", { account: "pwn300" }),
  member("spiral", { account: "spiral" }),
  member("rzz", { account: "rzz" }),
  member("fox", { account: "vulpes" }),
  member("guest41"),
];

const SYLLABLES = [
  "ne", "tro", "vex", "kai", "zor", "lum", "fen", "qui",
  "dar", "syn", "pho", "rax", "mir", "tul", "gav", "eko",
];

const AWAY_REASONS = ["afk", "commuting", "in a meeting", "sleep", ""];

/** A channel big enough to make the virtualiser earn its keep. Deterministic:
 * the same count always yields the same list. */
export function crowd(count: number): Member[] {
  let seed = 0x2f6e2b1;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const pick = <T>(items: readonly T[]): T => items[next() % items.length]!;

  const members: Member[] = [];
  for (let i = 0; i < count; i += 1) {
    const nick = `${pick(SYLLABLES)}${pick(SYLLABLES)}${i}`;
    const roll = next() % 100;
    const prefixes = roll < 3 ? ["@"] : roll < 5 ? ["@", "+"] : roll < 12 ? ["+"] : [];
    members.push({
      nick: roll % 7 === 0 ? nick.toUpperCase() : nick,
      account: next() % 100 < 60 ? nick : null,
      prefixes,
      away: next() % 100 < 8 ? pick(AWAY_REASONS) : null,
    });
  }
  return members;
}

export const LIBERA: Network = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  status: { state: "connected" },
  currentNick: "sable",
  sasl: { state: "authenticated", detail: { account: "sable" } },
  capsEnabled: ["server-time", "multi-prefix", "account-notify"],
  lagMs: 42,
};

export const CTF_OPS: Channel = {
  network: "libera",
  name: "#ctf-ops",
  topic: {
    text: "CTF discussions and operations",
    setBy: "sable",
    setAt: "2026-07-28T02:40:00Z",
  },
  modes: "+nt",
  joined: true,
  memberCount: CTF_OPS_MEMBERS.length,
  unread: 0,
  highlights: 0,
};
