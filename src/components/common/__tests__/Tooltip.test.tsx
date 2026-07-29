import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "../IconButton";
import { Tooltip } from "../Tooltip";

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
