import { describe, expect, it } from "vitest";
import { rosterWidth } from "./ContextPanel";
import { member } from "./fixtures";

/**
 * #114: a fixed column meant three nicks reserved the room four hundred would
 * need, and in a split pane that left the conversation unreadable.
 *
 * The width is asserted here rather than through a render because jsdom's CSS
 * parser drops a `clamp()` carrying `ch` arithmetic — `style.width` comes back
 * empty, so a rendered assertion would pass against nothing at all. The list is
 * monospace, which is what makes the arithmetic exact rather than a guess.
 */
describe("how wide the roster asks to be", () => {
  it("asks for room for the longest name it holds", () => {
    const width = rosterWidth([member("syk"), member("halloy5505"), member("syker_")], false);
    expect(width).toContain("10ch");
  });

  it("counts the prefixes, which are drawn in the same column", () => {
    expect(rosterWidth([member("ash", { prefixes: ["~", "@", "+"] })], false)).toContain("6ch");
  });

  it("never asks for less than the heading above it needs", () => {
    // "MEMBERS — 1" is wider than a one-character channel, so the floor holds.
    expect(rosterWidth([member("a")], false)).toMatch(/^clamp\(7rem,/);
  });

  it("stops at the width it used to always be", () => {
    const long = member("a-nick-far-longer-than-any-column-should-carry");
    expect(rosterWidth([long], false)).toMatch(/13rem\)$/);
  });

  it("gives the inspector the whole column, whatever the nicks are", () => {
    expect(rosterWidth([member("syk")], true)).toBe("13rem");
  });

  it("asks for the floor when there is nobody to list yet", () => {
    expect(rosterWidth([], false)).toMatch(/^clamp\(7rem, 0ch/);
  });
});
