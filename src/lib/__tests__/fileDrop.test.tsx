import { render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { insideTauri, onFileDrop } from "@/lib/ipc";

/**
 * #209. The real `@tauri-apps/api/webview`, not a mock: what is under test is
 * what happens when the globals it reads are absent, which is every context
 * except the app itself — vitest, and the browser the UI driver runs in.
 */
describe("outside the app", () => {
  it("knows it is not in a Tauri webview", () => {
    expect(insideTauri()).toBe(false);
  });

  it("subscribes to nothing rather than throwing", async () => {
    const handler = vi.fn();

    const stop = await onFileDrop(handler);

    expect(typeof stop).toBe("function");
    expect(handler).not.toHaveBeenCalled();
    // Unsubscribing has to be safe too: the component calls it on unmount
    // whether or not anything was ever subscribed.
    expect(() => stop()).not.toThrow();
  });

  /**
   * The failure this closes was not the throw but where it landed. It happened
   * inside the effect that mounts the drop target, so React unmounted the tree
   * and left a window that was the right colour and completely empty — a
   * crash that read as a stylesheet problem.
   */
  it("leaves a component that subscribes on mount standing", () => {
    function Mounts() {
      useEffect(() => {
        const stop = onFileDrop(() => {});
        return () => void stop.then((off) => off());
      }, []);
      return <p>the tree survived</p>;
    }

    const { getByText } = render(<Mounts />);

    expect(getByText("the tree survived")).toBeTruthy();
  });
});
