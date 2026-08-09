import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { catalogue } from "@/lib/theme";
import { useAppStore } from "@/store";
import type * as Session from "@/lib/theme/session";
import { SettingsWindow } from "./SettingsWindow";

const { closeMock, syncMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  syncMock: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: { installTheme: vi.fn(), themesDirectory: vi.fn(), listPlugins: vi.fn(() => Promise.resolve([])) },
  onThemesChanged: vi.fn(() => Promise.resolve(() => {})),
  onSettingsChanged: vi.fn(() => Promise.resolve(() => {})),
  onSettingsSection: vi.fn(() => Promise.resolve(() => {})),
  announceSettings: vi.fn(() => Promise.resolve()),
  setWindowZoom: vi.fn(() => Promise.resolve()),
  chooseFolder: vi.fn(),
  revealFolder: vi.fn(),
  // The window's own controls are live here, which is what lets Escape be
  // asserted at all: `insideTauri` false makes every one of them inert.
  insideTauri: () => true,
  reasonOr: (reason: unknown, fallback: string) =>
    typeof reason === "string" && reason.trim() !== "" ? reason : fallback,
}));

vi.mock("@/lib/theme/session", async (importOriginal) => ({
  ...(await importOriginal<typeof Session>()),
  startThemes: vi.fn(() => Promise.resolve(() => {})),
  startAppearanceSync: syncMock,
}));

beforeEach(() => {
  resetStore();
  useAppStore.setState({ themes: catalogue().themes });
});

afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute("style");
  localStorage.clear();
});

describe("the settings window", () => {
  it("opens on the first section", () => {
    render(<SettingsWindow />);

    expect(screen.getByRole("tab", { name: "Appearance" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("heading", { name: "Appearance", level: 2 })).toBeTruthy();
  });

  /** The client's own store is fed by the event pump in src/lib/bridge.ts, and
   * none of what it carries is a setting. What this window does start is the
   * themes directory and the other window's appearance. */
  it("follows the other window's appearance while it is open", () => {
    const { unmount } = render(<SettingsWindow />);
    expect(syncMock).toHaveBeenCalled();

    unmount();
  });

  /**
   * On the document rather than in the tree. A window opens with focus on
   * `document.body`, which is outside the React root, so a handler on the
   * element would not see the keystroke until something inside had been
   * clicked — Escape would work only for somebody who did not need it.
   */
  it("closes on Escape with focus where a new window leaves it", () => {
    render(<SettingsWindow />);
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(closeMock).toHaveBeenCalled();
  });

  /** Escape in a field abandons the value being typed. The token editor behind
   * Custom… is nothing but fields, and losing the window from one of them
   * would be a trap. */
  it("stays open for an Escape inside a field", () => {
    render(<SettingsWindow />);
    // Custom… is the way through to the token editor, which is the screen this
    // rule exists for: nothing but colour fields, each one abandoned with
    // Escape.
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));

    fireEvent.keyDown(screen.getByLabelText("--accent"), { key: "Escape" });

    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes when Done is pressed", () => {
    render(<SettingsWindow />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(closeMock).toHaveBeenCalled();
  });

  /** Nothing is left listening on the document once the window is gone. */
  it("stops listening for Escape when it unmounts", () => {
    const { unmount } = render(<SettingsWindow />);
    unmount();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(closeMock).not.toHaveBeenCalled();
  });
});
