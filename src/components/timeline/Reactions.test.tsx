import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordRecent } from "@/lib/emojiPrefs";
import { Reactions, RowControls } from "./Reactions";

/** The picker's height, and the room a row has above it. */
const PICKER_PX = 40;
const TIMELINE_TOP = 100;

/**
 * jsdom lays nothing out, so the measurements the flip is decided on are
 * stated here. `openAt` puts the button between the two amounts of room.
 */
function openAt(roomAbove: number, roomBelow = 300) {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const timeline = this.dataset.ui === "timeline";
      const top = timeline ? TIMELINE_TOP : TIMELINE_TOP + roomAbove;
      const bottom = timeline ? TIMELINE_TOP + roomAbove + roomBelow : top;
      return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top } as DOMRect;
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

  it("opens upward near the composer when neither side fits", () => {
    const className = openAt(PICKER_PX - 1, 8);
    expect(className).toContain("bottom-full");
    expect(className).not.toContain("top-full");
  });
});
