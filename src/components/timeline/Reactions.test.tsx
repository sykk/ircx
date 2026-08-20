import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowControls } from "./Reactions";

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

describe("the reaction picker", () => {
  it("opens upward, over the rows that painted before it", () => {
    expect(openAt(PICKER_PX * 4)).toContain("bottom-full");
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
