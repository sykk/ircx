import { describe, expect, it } from "vitest";
import { hangingMenuAt } from "../hangingMenu";

/** The ⋮ button on a network row, in a sidebar at its 180px floor: it sits
 * about 137px in, once the close button and the row's own padding are taken
 * off. The window is the one in the report. */
const NARROW = { left: 125, right: 137, top: 210, bottom: 226 };
const MENU = { width: 176, height: 120 };
const WINDOW = { width: 1152, height: 699 };

describe("a menu hanging off a button", () => {
  it("right-aligns to the button and sits under it when there is room", () => {
    const at = hangingMenuAt({ left: 300, right: 400, top: 100, bottom: 116 }, MENU, WINDOW);

    expect(at.left).toBe(400 - MENU.width);
    expect(at.top).toBe(120);
  });

  /** The reported bug. Right-aligned to a button 137px into the window, a 176px
   * menu starts at -39 and the reader sees four labels with the first word of
   * each cut off. */
  it("stays inside the window when the sidebar is at its narrowest", () => {
    const at = hangingMenuAt(NARROW, MENU, WINDOW);

    expect(NARROW.right - MENU.width).toBeLessThan(0);
    expect(at.left).toBeGreaterThanOrEqual(8);
  });

  it("flips above the button when there is no room below", () => {
    const low = { left: 125, right: 137, top: 640, bottom: 656 };
    const at = hangingMenuAt(low, MENU, WINDOW);

    expect(at.top).toBe(low.top - MENU.height - 4);
    expect(at.top + MENU.height).toBeLessThan(low.top);
  });

  /** A menu taller than the window it is in cannot satisfy both edges. It
   * answers for the top one, because that is where the first item is. */
  it("keeps the first item on screen when the menu is taller than the window", () => {
    const at = hangingMenuAt(NARROW, { width: 176, height: 900 }, WINDOW);

    expect(at.top).toBe(8);
  });

  it("does not move a menu that already fits", () => {
    const at = hangingMenuAt({ left: 500, right: 600, top: 100, bottom: 116 }, MENU, WINDOW);

    expect(at.left).toBe(424);
  });
});

/** The conversation menu hangs off the row it was right-clicked on rather than
 * off a button inside it, so at the same floor it is aligned to 180px of row and
 * clears the left edge on its own. What it shares with the network menu is the
 * list: both sit in an `overflow-y-auto` scroller, which clips them near the
 * bottom whatever their coordinates. */
describe("a menu hanging off a sidebar row", () => {
  const ROW = { left: 0, right: 180, top: 210, bottom: 236 };
  const ONE_ITEM = { width: 176, height: 44 };

  /** Right-aligning it to 180px of row leaves it 4px from the window, which is
   * inside the 8px every other measured box keeps, so it moves the 4px out. It
   * cleared the edge before this change and now clears it by the same margin
   * the tooltips do. */
  it("takes the window margin the rest of the app keeps", () => {
    const at = hangingMenuAt(ROW, ONE_ITEM, WINDOW);

    expect(ROW.right - ONE_ITEM.width).toBe(4);
    expect(at.left).toBe(8);
    expect(at.top).toBe(240);
  });

  /** The bug the row's own width hid: cut off by the bottom of the list rather
   * than by the left of the window. */
  it("opens upwards for a row near the bottom of a long list", () => {
    const low = { left: 0, right: 180, top: 660, bottom: 686 };
    const at = hangingMenuAt(low, ONE_ITEM, WINDOW);

    expect(at.top).toBe(low.top - ONE_ITEM.height - 4);
    expect(at.top + ONE_ITEM.height).toBeLessThanOrEqual(low.top);
  });
});
