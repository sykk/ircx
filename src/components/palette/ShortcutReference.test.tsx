import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { DEFAULT_BINDINGS, displayChord } from "@/lib/keybindings";
import { useAppStore } from "@/store";
import { ShortcutReference } from "./ShortcutReference";

beforeEach(resetStore);

describe("ShortcutReference", () => {
  it("draws nothing while closed", () => {
    render(<ShortcutReference />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every default binding", () => {
    useAppStore.getState().openShortcuts();
    render(<ShortcutReference />);

    for (const binding of DEFAULT_BINDINGS) {
      expect(screen.getByText(binding.description)).toBeTruthy();
      expect(screen.getAllByText(displayChord(binding.chord)).length).toBeGreaterThan(0);
    }
  });

  it("closes on Escape", () => {
    useAppStore.getState().openShortcuts();
    render(<ShortcutReference />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(useAppStore.getState().shortcutsOpen).toBe(false);
  });

  it("closes from its button", () => {
    useAppStore.getState().openShortcuts();
    render(<ShortcutReference />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useAppStore.getState().shortcutsOpen).toBe(false);
  });
});
