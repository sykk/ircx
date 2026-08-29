import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordRecent } from "@/lib/emojiPrefs";
import { Reactions, RowControls } from "./Reactions";

/** The compact picker's height, and the room a row has above it. */
const PICKER_PX = 40;
const TIMELINE_TOP = 100;

/**
 * jsdom lays nothing out, so the two measurements the flip is decided on are
 * stated here: where the timeline's top edge is, and how tall the picker is.
 * `openAt` puts the button that many pixels below the timeline's top.
 */
function openAt(roomAbove: number) {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.ui === "timeline" ? TIMELINE_TOP : TIMELINE_TOP + roomAbove;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockReturnValue(PICKER_PX);

  render(
    <div data-ui="timeline">
      <RowControls alone={false} onReply={null} onBookmark={null} bookmarked={false} onPick={vi.fn()} />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add a reaction" }));

  const panel = screen.getByRole("button", { name: "Add a reaction" }).parentElement
    ?.querySelector("span.absolute");
  const className = panel?.className ?? "";
  rect.mockRestore();
  height.mockRestore();
  return className;
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => localStorage.clear());

describe("the reaction picker", () => {
  it("keeps quick reactions out of the reacted row", () => {
    render(
      <Reactions
        reactions={[{ emoji: "👍", nicks: ["syk"] }]}
        ownNick="syk"
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "👍 — you" })).toBeTruthy();
  });

  it("offers the three most-used emoji as quick reactions", () => {
    recordRecent("🔥");
    recordRecent("😂");
    recordRecent("🔥");
    recordRecent("🎉");

    render(
      <RowControls
        alone={false}
        onReply={null}
        onBookmark={null}
        bookmarked={false}
        onPick={vi.fn()}
      />,
    );

    const quick = screen.getAllByRole("button", { name: /^React with / });
    expect(quick.map((button) => button.getAttribute("aria-label"))).toEqual([
      "React with 🔥",
      "React with 🎉",
      "React with 😂",
    ]);
  });

  it("opens upward, over the rows that painted before it", () => {
    const className = openAt(PICKER_PX * 4);
    expect(className).toContain("bottom-full");
    expect(className).toContain("right-0");
  });

  // Near the top of the scroller there is nothing above to open into, and it
  // used to go out over the channel header — the one place in this app
  // anything is drawn over it. #580.
  it("opens downward where there is no room above it", () => {
    const className = openAt(PICKER_PX - 1);
    expect(className).toContain("top-full");
    expect(className).not.toContain("bottom-full");
  });
});
