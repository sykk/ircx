import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StartupFailure } from "../StartupFailure";

describe("StartupFailure", () => {
  /** Every Tauri command in this client answers with a sentence written for a
   * person, so the backend has already said the useful thing. */
  it("shows the reason the backend gave rather than one of its own", () => {
    render(<StartupFailure reason="The archive is locked by another copy of ircx." onRetry={() => {}} />);
    expect(screen.getByText("The archive is locked by another copy of ircx.")).toBeTruthy();
  });

  /** A window that cannot say anything is a window nobody can act on, so this
   * announces itself rather than waiting to be found. */
  it("announces itself", () => {
    render(<StartupFailure reason="locked" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("offers to try again", () => {
    const retry = vi.fn();
    render(<StartupFailure reason="locked" onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
