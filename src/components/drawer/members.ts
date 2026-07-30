import type { Member } from "@/types";

/* The store exports a three-way `MemberGroup` splitting voiced off from plain
 * members. The list draws two groups (READABILITY.md §4.2), so it is shadowed
 * here rather than changed there; voice still shows as the row's `+` sigil. */
export type MemberGroup = "operators" | "members";

export const GROUP_ORDER: MemberGroup[] = ["operators", "members"];

export const GROUP_LABEL: Record<MemberGroup, string> = {
  operators: "Operators",
  members: "Members",
};

export function groupOf(member: Member): MemberGroup {
  const top = member.prefixes[0];
  return top === "~" || top === "&" || top === "@" ? "operators" : "members";
}

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
  const buckets: Record<MemberGroup, Member[]> = { operators: [], members: [] };
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
  | { kind: "more"; hidden: number };

/** How much of the members group is shown before `… and n more` takes over. */
export const MEMBERS_PREVIEW = 10;

/** Sections to a flat row list, which is what the virtualiser indexes into.
 * Operators are enumerated whatever their number; only the members group
 * truncates, and only until `expandMembers` (READABILITY.md §4.2). */
export function toRows(sections: MemberSection[], expandMembers = false): MemberRow[] {
  const rows: MemberRow[] = [];
  for (const section of sections) {
    rows.push({ kind: "header", group: section.group, count: section.members.length });

    const truncates = section.group === "members" && !expandMembers;
    const hidden = truncates
      ? Math.max(0, section.members.length - MEMBERS_PREVIEW)
      : 0;
    const shown =
      hidden === 0 ? section.members : section.members.slice(0, MEMBERS_PREVIEW);

    for (const member of shown) rows.push({ kind: "member", member });
    if (hidden > 0) rows.push({ kind: "more", hidden });
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
