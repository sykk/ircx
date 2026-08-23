import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { catalogue } from "@/lib/theme";
import { useAppStore } from "@/store";
import { SettingsOverlay } from "./SettingsOverlay";

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
  render(<SettingsOverlay />);
}

/** What the dialog is drawn over, which is what a click outside it lands on. */
const outside = () => screen.getByRole("dialog").parentElement!;

describe("the settings dialog", () => {
  it("draws nothing while settings is closed", () => {
    render(<SettingsOverlay />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws the section it was opened on", async () => {
    open("privacy");
    await act(async () => {});

    expect(screen.getByRole("tab", { name: "Privacy" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Privacy", level: 2 })).toBeTruthy();
  });

  /** The section is the store's, not the component's: reopening from the
   * palette lands on a section, and a copy held in component state would be a
   * second answer to which one. */
  it("moves the store when a section is chosen", async () => {
    open();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Uploads" }));
    });

    expect(store().settings).toBe("uploads");
    expect(screen.getByRole("heading", { name: "Uploads", level: 2 })).toBeTruthy();
  });

  it("closes when Done is pressed", () => {
    open();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(store().settings).toBeNull();
  });

  it("closes on Escape", () => {
    open();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(store().settings).toBeNull();
  });

  /** Escape in a field abandons the value being typed. The token editor behind
   * Custom… is nothing but fields, and losing the dialog from one of them
   * would be a trap. */
  it("stays open for an Escape inside a field", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Custom…" }));

    fireEvent.keyDown(await screen.findByLabelText("--accent"), { key: "Escape" });

    expect(store().settings).toBe("appearance");
  });

  it("closes on a click outside it", () => {
    open();

    fireEvent.mouseDown(outside());

    expect(store().settings).toBeNull();
  });

  it("stays open for a click inside it", () => {
    open();

    fireEvent.mouseDown(screen.getByRole("dialog"));

    expect(store().settings).toBe("appearance");
  });

  /** Privacy and Notifications are both asked about "this conversation". The
   * dialog is over the window that has one, so it reads it out of the store
   * rather than being handed it. */
  it("scopes its pages to the conversation behind it", async () => {
    open("privacy");
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Delete #ctf-ops" })).toBeTruthy();
  });
});
