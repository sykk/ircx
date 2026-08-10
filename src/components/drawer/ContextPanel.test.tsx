import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { TEST_VIEW, oneView, resetStore } from "@/components/shell/fixtures";
import { ContextPanel, rosterWidth } from "./ContextPanel";
import { CTF_OPS, CTF_OPS_MEMBERS, LIBERA, member } from "./fixtures";

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
    const width = rosterWidth([member("nyx"), member("bitwise"), member("sable")], false);
    expect(width).toContain("7ch");
  });

  it("counts the prefixes, which are drawn in the same column", () => {
    // `Ariel` carries all three in `CTF_OPS_MEMBERS`, which is why she is there.
    const founder = member("Ariel", { prefixes: ["~", "@", "+"] });
    expect(rosterWidth([founder], false)).toContain("8ch");
  });

  it("never asks for less than the heading above it needs", () => {
    // "MEMBERS — 1" is wider than a one-character nick, so the floor holds.
    // The whole clamp is pinned: the bounds are constants, so matching only
    // them passed for any input.
    expect(rosterWidth([member("j")], false)).toBe("clamp(8rem, 1ch + 3.5rem, 13rem)");
  });

  it("stops at the width it used to always be", () => {
    const long = member("a-nick-far-longer-than-any-column-should-carry");
    expect(rosterWidth([long], false)).toBe("clamp(8rem, 46ch + 3.5rem, 13rem)");
  });

  it("gives the inspector the whole column, whatever the nicks are", () => {
    expect(rosterWidth([member("nyx")], true)).toBe("13rem");
  });

  it("asks for the floor when there is nobody to list yet", () => {
    expect(rosterWidth([], false)).toMatch(/^clamp\(8rem, 0ch/);
  });
});

/* The virtualiser inside `MemberList` sizes itself from the scroll container,
 * which jsdom reports as zero high — without this it renders no rows to filter. */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
});

/**
 * #482. The filter is absent until it is used, which is the roster
 * `docs/mockup.png` draws, so a key is what opens it and there is nothing on
 * screen to click.
 */
describe("filtering the roster", () => {
  const roster = () => screen.getByRole("complementary");
  const strip = () => screen.queryByRole("textbox", { name: /Filter #ctf-ops members/ });

  beforeEach(() => {
    resetStore();
    useAppStore.setState({
      networks: { libera: LIBERA },
      networkOrder: ["libera"],
      channels: { [targetKey("libera", CTF_OPS.name)]: CTF_OPS },
      members: { [targetKey("libera", CTF_OPS.name)]: CTF_OPS_MEMBERS },
      ...oneView({ network: "libera", target: CTF_OPS.name }),
    });
    render(<ContextPanel view={TEST_VIEW} />);
  });

  it("draws no filter until one is asked for", () => {
    expect(strip()).toBeNull();
  });

  it("opens on a typed character, carrying it", () => {
    fireEvent.keyDown(roster(), { key: "r" });

    expect(strip()).toHaveProperty("value", "r");
    expect(useAppStore.getState().memberFilter[TEST_VIEW]).toBe("r");
  });

  it("gives the caret to the field it just opened", () => {
    fireEvent.keyDown(roster(), { key: "r" });

    expect(document.activeElement).toBe(strip());
  });

  it("narrows the list to what is typed into it", () => {
    fireEvent.keyDown(roster(), { key: "r" });
    fireEvent.change(strip()!, { target: { value: "ra" } });

    expect(screen.getByRole("button", { name: /phrack/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /marrow/ })).toBeNull();
  });

  it("leaves a chord to whatever else wants it", () => {
    fireEvent.keyDown(roster(), { key: "k", ctrlKey: true });

    expect(strip()).toBeNull();
  });

  /* Space is how a focused row is activated, so it cannot also be the first
   * character of a filter. */
  it("does not open on a space", () => {
    fireEvent.keyDown(roster(), { key: " " });

    expect(strip()).toBeNull();
  });

  /* Asserted on the store rather than on the screen: the band hides the filter
   * under the inspector either way, so a strip that is merely not drawn would
   * pass for a filter that was never opened — and the defect is the roster
   * coming back narrowed by a letter meant for a field. */
  it("does not open over the inspector, whose fields a letter may be meant for", () => {
    // Clicked rather than set on the store: a write from outside React's own
    // event system has not re-rendered by the time the key is dispatched, so
    // the handler would still be looking at a roster with no inspector over it.
    fireEvent.click(screen.getByRole("button", { name: /phrack/ }));

    fireEvent.keyDown(roster(), { key: "r" });

    expect(useAppStore.getState().memberFilter[TEST_VIEW]).toBeUndefined();
    expect(strip()).toBeNull();
  });

  it("closes on Escape, before the roster itself", () => {
    fireEvent.keyDown(roster(), { key: "r" });
    fireEvent.keyDown(strip()!, { key: "Escape" });

    expect(strip()).toBeNull();
    expect(useAppStore.getState().rosterHidden[TEST_VIEW]).not.toBe(true);
  });

  /* The inspector covers the filter rather than replacing it, so Escape has to
   * take the inspector first — closing the filter under it would spend the key
   * on something the reader cannot see. */
  it("leaves a filter alone while the inspector is over it", () => {
    fireEvent.keyDown(roster(), { key: "r" });
    fireEvent.click(screen.getByRole("button", { name: /phrack/ }));
    expect(strip()).toBeNull();

    fireEvent.keyDown(roster(), { key: "Escape" });

    expect(useAppStore.getState().views[TEST_VIEW]?.selectedUser).toBeNull();
    expect(strip()).toHaveProperty("value", "r");
  });

  /* The field Escape was pressed in unmounts with it. Focus left on `body` is
   * outside the tree the column's handler listens in, so the next Escape — the
   * one that closes the roster — would reach nothing at all. */
  it("puts focus back on the column, so the next Escape still lands", () => {
    fireEvent.keyDown(roster(), { key: "r" });
    fireEvent.keyDown(strip()!, { key: "Escape" });
    expect(document.activeElement).toBe(roster());

    fireEvent.keyDown(roster(), { key: "Escape" });

    expect(useAppStore.getState().rosterHidden[TEST_VIEW]).toBe(true);
  });

  it("closes on the clear button too", () => {
    fireEvent.keyDown(roster(), { key: "r" });
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(roster());
  });

  /* `retarget` drops it with the rest of what a pane holds about one
   * conversation, so nothing here has to notice the channel changed. */
  it("does not follow the pane into another channel", () => {
    fireEvent.keyDown(roster(), { key: "r" });

    useAppStore.getState().showTarget({ network: "libera", target: "#hackint" });

    // Asserted, so that a `showTarget` that stopped moving this pane could not
    // leave the line below passing for a filter nothing had cleared.
    expect(useAppStore.getState().views[TEST_VIEW]?.target).toBe("#hackint");
    expect(useAppStore.getState().memberFilter[TEST_VIEW]).toBeUndefined();
  });
});
