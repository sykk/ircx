import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { catalogue } from "@/lib/theme";
import { useAppStore } from "@/store";
import { SettingsPane } from "./SettingsPane";

vi.mock("@/lib/ipc", () => ({
  // Each page reaches for the backend the moment it is drawn. What comes back
  // is not what this file is about — where the pages are drawn is.
  ipc: {
    installTheme: vi.fn(),
    themesDirectory: vi.fn(),
    listPlugins: vi.fn(() => Promise.resolve([])),
    archiveSummary: vi.fn(() => Promise.resolve({ messages: 0n, bytes: 0n })),
    retention: vi.fn(() => Promise.resolve(null)),
    getUploadProvider: vi.fn(() => Promise.resolve(null)),
    highlightWords: vi.fn(() => Promise.resolve([])),
    mutedConversations: vi.fn(() => Promise.resolve([])),
  },
  onThemesChanged: vi.fn(() => Promise.resolve(() => {})),
  setWindowZoom: vi.fn(() => Promise.resolve()),
  chooseFolder: vi.fn(),
  revealFolder: vi.fn(),
  insideTauri: () => false,
  reasonOr: (reason: unknown, fallback: string) =>
    typeof reason === "string" && reason.trim() !== "" ? reason : fallback,
}));

const store = () => useAppStore.getState();

beforeEach(() => {
  resetStore();
  useAppStore.setState({ themes: catalogue().themes });
  seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
  store().showTarget({ network: "libera", target: "#ctf-ops" });
});

afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute("style");
  localStorage.clear();
});

function open(section?: "appearance" | "privacy") {
  store().openSettings(section);
  render(<SettingsPane view={store().settings!.view} />);
}

describe("the settings pane", () => {
  it("draws the section the pane was opened on", () => {
    open("privacy");

    expect(screen.getByRole("tab", { name: "Privacy" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Privacy", level: 2 })).toBeTruthy();
  });

  /** The section is the pane's, not the component's: reopening the pane from
   * the palette lands on a section, and a copy held in component state would
   * be a second answer to which one. */
  it("moves the pane itself when a section is chosen", () => {
    open();

    fireEvent.click(screen.getByRole("tab", { name: "Uploads" }));

    expect(store().settings?.section).toBe("uploads");
    expect(screen.getByRole("heading", { name: "Uploads", level: 2 })).toBeTruthy();
  });

  it("closes the pane when Done is pressed", () => {
    open();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(store().settings).toBeNull();
    expect(store().viewOrder).toHaveLength(1);
  });

  /** Privacy and Notifications are both asked about "this conversation". As a
   * second window that had to be handed over; the pane is in the window that
   * has one. */
  it("scopes its pages to the conversation beside it", () => {
    open("privacy");

    expect(screen.getByRole("button", { name: "Delete #ctf-ops" })).toBeTruthy();
  });
});
