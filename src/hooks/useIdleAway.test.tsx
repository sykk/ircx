import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdleAway } from "./useIdleAway";

const setIdle = vi.fn<(idle: boolean) => Promise<void>>();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    setIdle: (idle: boolean) => setIdle(idle),
  },
}));

function type() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
}

function wait(minutes: number) {
  act(() => {
    vi.advanceTimersByTime(minutes * 60_000);
  });
}

describe("useIdleAway", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setIdle.mockReset();
    setIdle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says so once the keyboard has been quiet for the chosen time", () => {
    renderHook(() => useIdleAway(5));

    wait(4);
    expect(setIdle).not.toHaveBeenCalled();

    wait(1);
    expect(setIdle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("comes back on the first thing the reader does, and waits again", () => {
    renderHook(() => useIdleAway(5));
    wait(5);
    setIdle.mockClear();

    type();
    expect(setIdle).toHaveBeenCalledExactlyOnceWith(false);

    // The clock restarts from that keystroke rather than from the last report,
    // which is what makes this a measure of quiet and not of elapsed time.
    setIdle.mockClear();
    wait(4);
    expect(setIdle).not.toHaveBeenCalled();
    wait(1);
    expect(setIdle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("says nothing twice, however much the reader moves", () => {
    renderHook(() => useIdleAway(5));

    type();
    type();
    wait(5);
    wait(5);

    expect(setIdle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does nothing at all when nobody has chosen a time", () => {
    renderHook(() => useIdleAway(null));

    wait(120);
    type();

    expect(setIdle).not.toHaveBeenCalled();
  });

  /**
   * Turning it off while the reader is away has to bring them back. Nothing is
   * left running to do it afterwards, and an away nobody can cancel is worse
   * than one that was never set.
   */
  it("brings the reader back when the setting is turned off", () => {
    const { rerender } = renderHook(({ after }: { after: number | null }) => useIdleAway(after), {
      initialProps: { after: 5 as number | null },
    });
    wait(5);
    expect(setIdle).toHaveBeenCalledExactlyOnceWith(true);

    setIdle.mockClear();
    rerender({ after: null });
    expect(setIdle).toHaveBeenCalledExactlyOnceWith(false);
  });
});
