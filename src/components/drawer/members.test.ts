import { describe, expect, it } from "vitest";
import { groupOf } from "@/store/selectors";
import { CTF_OPS_MEMBERS, crowd, member } from "./fixtures";
import { GROUP_PREVIEW, actionsFor, groupMembers, rankOf, toRows } from "./members";

describe("groupMembers", () => {
  it("splits every prefix a server can send into three groups", () => {
    const sections = groupMembers([
      member("owner", { prefixes: ["~"] }),
      member("admin", { prefixes: ["&"] }),
      member("op", { prefixes: ["@"] }),
      member("halfop", { prefixes: ["%"] }),
      member("voiced", { prefixes: ["+"] }),
      member("plain"),
    ]);

    expect(sections.map((s) => [s.group, s.members.length])).toEqual([
      ["operators", 3],
      ["voiced", 2],
      ["members", 1],
    ]);
  });

  it("omits a group with nobody in it", () => {
    const sections = groupMembers([member("plain"), member("other")]);
    expect(sections.map((s) => s.group)).toEqual(["members"]);
  });

  it("groups on the top prefix when multi-prefix filled the rest in", () => {
    const founder = member("Ariel", { prefixes: ["~", "@", "+"] });
    expect(groupOf(founder)).toBe("operators");
    expect(groupMembers([founder])[0]?.members).toEqual([founder]);
  });

  it("groups the same when multi-prefix is absent and only the top arrives", () => {
    const withAll = groupMembers([member("Ariel", { prefixes: ["~", "@", "+"] })]);
    const topOnly = groupMembers([member("Ariel", { prefixes: ["~"] })]);
    expect(topOnly.map((s) => [s.group, s.members.length])).toEqual(
      withAll.map((s) => [s.group, s.members.length]),
    );
  });

  it("sorts case-insensitively inside a group", () => {
    const sections = groupMembers([
      member("zed"),
      member("Alpha"),
      member("beta"),
      member("ALPHA2"),
    ]);
    expect(sections[0]?.members.map((m) => m.nick)).toEqual([
      "Alpha",
      "ALPHA2",
      "beta",
      "zed",
    ]);
  });

  it("does not reorder the array it was given", () => {
    const members = [member("zed"), member("alpha")];
    groupMembers(members);
    expect(members.map((m) => m.nick)).toEqual(["zed", "alpha"]);
  });

  it("accounts for every member of a several-thousand channel", () => {
    const members = crowd(4000);
    const sections = groupMembers(members);
    const total = sections.reduce((sum, s) => sum + s.members.length, 0);
    expect(total).toBe(4000);
    expect(sections.map((s) => s.group)).toEqual(["operators", "voiced", "members"]);
  });
});

describe("toRows", () => {
  it("puts a counted header in front of each group", () => {
    const rows = toRows(groupMembers(CTF_OPS_MEMBERS));
    const headers = rows.filter((row) => row.kind === "header");
    expect(headers).toEqual([
      { kind: "header", group: "operators", count: 4 },
      { kind: "header", group: "voiced", count: 3 },
      { kind: "header", group: "members", count: 9 },
    ]);
    expect(rows.length).toBe(CTF_OPS_MEMBERS.length + headers.length);
  });

  it("stops a long group at the preview and counts what it withheld", () => {
    const rows = toRows(groupMembers(crowd(500)));
    const shown = rows.filter((row) => row.kind === "member");
    const more = rows.filter((row) => row.kind === "more");

    expect(shown.length).toBe(GROUP_PREVIEW * 3);
    expect(more.map((row) => row.group)).toEqual(["operators", "voiced", "members"]);
    expect(
      more.reduce((sum, row) => sum + row.hidden, 0) + shown.length,
    ).toBe(500);
  });

  it("shows the whole of a group named as expanded", () => {
    const sections = groupMembers(crowd(500));
    const rows = toRows(sections, new Set(["members"]));
    const members = sections.find((s) => s.group === "members")!.members.length;

    expect(rows.filter((row) => row.kind === "member").length).toBe(
      members + GROUP_PREVIEW * 2,
    );
    expect(rows.some((row) => row.kind === "more" && row.group === "members")).toBe(false);
  });
});

describe("rankOf", () => {
  it("reads the highest prefix and treats an unknown one as no privilege", () => {
    expect(rankOf(member("a", { prefixes: ["~"] }))).toBe(5);
    expect(rankOf(member("a", { prefixes: ["@", "+"] }))).toBe(3);
    expect(rankOf(member("a", { prefixes: ["!"] }))).toBe(0);
    expect(rankOf(member("a"))).toBe(0);
    expect(rankOf(undefined)).toBe(0);
  });
});

describe("actionsFor", () => {
  it("allows nothing to someone with no prefix", () => {
    expect(actionsFor(member("plain"))).toEqual({
      op: false,
      voice: false,
      kick: false,
      ban: false,
    });
  });

  it("allows nothing when the local user is not in the member list", () => {
    expect(actionsFor(undefined).kick).toBe(false);
  });

  it("lets a halfop kick and voice but not change ops or ban", () => {
    expect(actionsFor(member("halfop", { prefixes: ["%"] }))).toEqual({
      op: false,
      voice: true,
      kick: true,
      ban: false,
    });
  });

  it("allows everything to an operator", () => {
    expect(actionsFor(member("op", { prefixes: ["@"] }))).toEqual({
      op: true,
      voice: true,
      kick: true,
      ban: true,
    });
  });

  it("allows everything to a founder whose only prefix arrived", () => {
    expect(actionsFor(member("owner", { prefixes: ["~"] })).op).toBe(true);
  });
});
