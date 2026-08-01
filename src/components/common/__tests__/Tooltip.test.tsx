import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "../IconButton";
import { edgeShift, Tooltip } from "../Tooltip";

/** A 1200px window, which is what the measurements in #258 were taken in. */
const WINDOW = 1200;

describe("edgeShift", () => {
  it("leaves a box that already fits where it is", () => {
    expect(edgeShift({ left: 400, right: 700 }, WINDOW)).toBe(0);
  });

  it("pulls back a box hanging off the right, and no further", () => {
    // 523px past the right edge is the Libera capability list from #258.
    expect(edgeShift({ left: 318, right: 1723 }, WINDOW)).toBe(-531);
  });

  it("pushes out a box hanging off the left", () => {
    expect(edgeShift({ left: -502, right: 688 }, WINDOW)).toBe(510);
  });

  it("keeps a margin rather than butting the box against the glass", () => {
    expect(edgeShift({ left: 8, right: 1192 }, WINDOW)).toBe(0);
    expect(edgeShift({ left: 0, right: 1184 }, WINDOW)).toBe(8);
  });

  /** Nothing fits, so it answers for the edge a line of text starts at. */
  it("shows the start of a box too wide for the window at all", () => {
    expect(edgeShift({ left: -100, right: 1400 }, WINDOW)).toBe(108);
  });
});

describe("Tooltip", () => {
  it("stays hidden until the pointer arrives", () => {
    render(
      <Tooltip label="Sidebar width">
        <span>handle</span>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(screen.getByText("handle").parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("Sidebar width");
  });

  it("appears on keyboard focus so it is not mouse-only", () => {
    const onClick = vi.fn();
    render(<IconButton icon="close" label="Close" onClick={onClick} />);

    fireEvent.focus(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Close");

    fireEvent.blur(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
