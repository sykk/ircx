import type { Member } from "@/types";
import { groupOf, type MemberGroup } from "@/store/selectors";

export const GROUP_ORDER: MemberGroup[] = ["operators", "voiced", "members"];

export const GROUP_LABEL: Record<MemberGroup, string> = {
  operators: "Operators",
  voiced: "Voiced",
  members: "Members",
};

const PREFIX_RANK: Record<string, number> = { "~": 5, "&": 4, "@": 3, "%": 2, "+": 1 };

/** 0 for a plain member. Reads `prefixes[0]`, which is the only entry that is
 * guaranteed present: without `multi-prefix` the server sends the highest one. */
export function rankOf(member: Member | undefined): number {
  const top = member?.prefixes[0];
  return top === undefined ? 0 : (PREFIX_RANK[top] ?? 0);
}

export interface MemberSection {
  group: MemberGroup;
  members: Member[];
}

export function groupMembers(members: Member[]): MemberSection[] {
  const buckets: Record<MemberGroup, Member[]> = { operators: [], voiced: [], members: [] };
  for (const member of members) buckets[groupOf(member)].push(member);
  return GROUP_ORDER.filter((group) => buckets[group].length > 0).map((group) => ({
    group,
    members: buckets[group].sort(byNick),
  }));
}

function byNick(a: Member, b: Member): number {
  const left = a.nick.toLowerCase();
  const right = b.nick.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0;
}

export type MemberRow =
  | { kind: "header"; group: MemberGroup; count: number }
  | { kind: "member"; member: Member }
  | { kind: "more"; group: MemberGroup; hidden: number };

/** How much of a group is shown before the `… and n more` row takes over. */
export const GROUP_PREVIEW = 10;

/** Sections to a flat row list, which is what the virtualiser indexes into.
 * Groups not named in `expanded` stop after `GROUP_PREVIEW` members. */
export function toRows(
  sections: MemberSection[],
  expanded: ReadonlySet<MemberGroup> = new Set(),
): MemberRow[] {
  const rows: MemberRow[] = [];
  for (const section of sections) {
    rows.push({ kind: "header", group: section.group, count: section.members.length });
    const hidden = expanded.has(section.group)
      ? 0
      : Math.max(0, section.members.length - GROUP_PREVIEW);
    const shown = hidden === 0 ? section.members : section.members.slice(0, GROUP_PREVIEW);
    for (const member of shown) rows.push({ kind: "member", member });
    if (hidden > 0) rows.push({ kind: "more", group: section.group, hidden });
  }
  return rows;
}

export interface MemberActions {
  op: boolean;
  voice: boolean;
  kick: boolean;
  ban: boolean;
}

/** What the local user may do to someone else. Halfops kick and voice; changing
 * ops or setting a ban takes `@` or better. */
export function actionsFor(self: Member | undefined): MemberActions {
  const rank = rankOf(self);
  return { op: rank >= 3, voice: rank >= 2, kick: rank >= 2, ban: rank >= 3 };
}

const NICK_COLOUR_COUNT = 10;

export function nickColour(nick: string): string {
  let hash = 0;
  for (const char of nick.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--nick-${(hash % NICK_COLOUR_COUNT) + 1})`;
}
