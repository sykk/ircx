import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { resetStore } from "@/components/shell/fixtures";
import type * as Ipc from "@/lib/ipc";
import type { SettingsScope } from "@/components/settings/scope";
import type * as Notifications from "@/lib/notifications";
import { NotificationsPage } from "./NotificationsPage";

const { ipcMock, allowedMock } = vi.hoisted(() => ({
  ipcMock: {
    highlightWords: vi.fn(),
    setHighlightWords: vi.fn(),
    mutedConversations: vi.fn(),
    setMuted: vi.fn(),
    ignoredPeople: vi.fn(),
    setIgnored: vi.fn(),
    watchedPeople: vi.fn(),
    setWatched: vi.fn(),
  },
  allowedMock: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: ipcMock,
  onIrcxEvent: vi.fn(),
}));

vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  // The desktop's answer, which no test here is about. The page's own job is
  // to leave the switch off when it is refused.
  allowedToNotify: allowedMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  ipcMock.highlightWords.mockResolvedValue([]);
  ipcMock.setHighlightWords.mockResolvedValue(undefined);
  ipcMock.mutedConversations.mockResolvedValue([]);
  ipcMock.setMuted.mockResolvedValue(undefined);
  ipcMock.ignoredPeople.mockResolvedValue([]);
  ipcMock.setIgnored.mockResolvedValue(undefined);
  ipcMock.watchedPeople.mockResolvedValue([]);
  ipcMock.setWatched.mockResolvedValue(undefined);
  allowedMock.mockResolvedValue(true);
  localStorage.clear();
});

const done = vi.fn();

/** The conversation the pane is scoped to, as `useSettingsScope` reads it. */
const HERE = { network: "libera", networkName: "Libera.Chat", target: "#ircx" };

function open(here: SettingsScope | null = HERE) {
  render(<NotificationsPage here={here} onDone={done} />);
}

async function type(word: string) {
  fireEvent.change(await screen.findByLabelText("Add a word"), { target: { value: word } });
}

describe("the notifications page", () => {
  it("writes a word the moment it is added", async () => {
    open();
    await type("deploy");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(ipcMock.setHighlightWords).toHaveBeenCalledWith(["deploy"]));
    expect(await screen.findByRole("button", { name: "Remove deploy" })).toBeTruthy();
  });

  /** The timeline tints a line against the store's copy, which is still the
   * list from before the word was added until the page puts the new one there. */
  it("puts the new list where the timeline reads it", async () => {
    open();
    await type("deploy");
    ipcMock.highlightWords.mockResolvedValue(["deploy"]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(useAppStore.getState().highlightWords).toEqual(["deploy"]));
  });

  it("keeps the order the words were added in", async () => {
    ipcMock.highlightWords.mockResolvedValue(["deploy"]);
    open();
    await type("release");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(ipcMock.setHighlightWords).toHaveBeenCalledWith(["deploy", "release"]),
    );
  });

  it("removes the word that was asked for, not the one beside it", async () => {
    ipcMock.highlightWords.mockResolvedValue(["deploy", "release"]);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Remove deploy" }));

    await waitFor(() => expect(ipcMock.setHighlightWords).toHaveBeenCalledWith(["release"]));
  });

  /** The match is caseless, so a second spelling is a word that would change
   * nothing — and the store would drop it on its caseless key anyway. */
  it("refuses a word already on the list, whatever the case", async () => {
    ipcMock.highlightWords.mockResolvedValue(["deploy"]);
    open();
    await type("Deploy");

    expect(await screen.findByText("Deploy is already on the list.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });

  /** The word appears as it is typed and the write follows. A refused write has
   * to take it back off the screen, or the page says the word is on a list it
   * is not on. */
  it("puts the list back when the write is refused", async () => {
    ipcMock.setHighlightWords.mockRejectedValue("The archive is read-only.");
    open();
    await type("deploy");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("The archive is read-only.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove deploy" })).toBeNull();
  });

  it("mutes the conversation the client was on", async () => {
    open();
    fireEvent.click(await screen.findByLabelText("Mute #ircx"));

    await waitFor(() => expect(ipcMock.setMuted).toHaveBeenCalledWith("libera", "#ircx", true));
  });

  /** A null target is the network itself, which is how the store keys it. */
  it("mutes a whole network", async () => {
    open();
    fireEvent.click(await screen.findByLabelText("Mute everything on Libera.Chat"));

    await waitFor(() => expect(ipcMock.setMuted).toHaveBeenCalledWith("libera", null, true));
  });

  it("marks the conversation as muted when it already is", async () => {
    ipcMock.mutedConversations.mockResolvedValue([
      { network: "libera", networkName: "Libera.Chat", target: "#IRCX" },
    ]);
    open();

    const box = await screen.findByLabelText("Mute #ircx");
    // Caselessly: the store keeps the target as it was typed, and a channel is
    // the same channel in either case.
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
  });

  /** The settings window knows one conversation. Everything else muted has to
   * be reachable from here or it cannot be undone from this window at all. */
  it("lists what is muted elsewhere, and unmutes it", async () => {
    ipcMock.mutedConversations.mockResolvedValue([
      { network: "hackint", networkName: "hackint", target: "#other" },
    ]);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Unmute" }));

    await waitFor(() => expect(ipcMock.setMuted).toHaveBeenCalledWith("hackint", "#other", false));
  });

  /** The only way back for an ignore made on a network you are no longer
   * connected to: `/unignore` needs a session to be typed into. */
  it("lists who is ignored, and stops", async () => {
    ipcMock.ignoredPeople.mockResolvedValue([
      { network: "hackint", networkName: "hackint", nick: "spambot" },
    ]);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Stop ignoring" }));

    await waitFor(() =>
      expect(ipcMock.setIgnored).toHaveBeenCalledWith("hackint", "spambot", false),
    );
  });

  it("adds and removes a saved nick watch on the scoped network", async () => {
    ipcMock.watchedPeople.mockResolvedValue([
      { network: "libera", networkName: "Libera.Chat", nick: "sable" },
    ]);
    open();
    fireEvent.change(await screen.findByLabelText("Watch a nick on Libera.Chat"), {
      target: { value: "willow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Watch" }));
    await waitFor(() => expect(ipcMock.setWatched).toHaveBeenCalledWith("libera", "willow", true));

    fireEvent.click(await screen.findByRole("button", { name: "Stop watching" }));
    await waitFor(() => expect(ipcMock.setWatched).toHaveBeenCalledWith("libera", "sable", false));
  });

  it("says where an ignore is started when nobody is", async () => {
    open();

    expect(await screen.findByText(/Nobody is ignored/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop ignoring" })).toBeNull();
  });

  it("says why the ignore list could not be read", async () => {
    ipcMock.ignoredPeople.mockRejectedValue("The archive is locked.");
    open();

    expect(await screen.findByText("The archive is locked.")).toBeTruthy();
  });

  it("offers nothing to mute when no conversation was open", async () => {
    open(null);

    expect(await screen.findByText(/Open this from a conversation to mute it/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Mute /)).toBeNull();
  });

  it("remembers a switch that was turned on", async () => {
    open();
    fireEvent.click(await screen.findByLabelText("Notify me about highlights"));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("ircx.notifications") ?? "{}")).toEqual({
        highlights: true,
        directMessages: false,
      }),
    );
  });

  /** A switch that reads as on and raises nothing is worse than one that never
   * went on. */
  it("leaves the switch off when the desktop refuses", async () => {
    allowedMock.mockResolvedValue(false);
    open();
    const box = await screen.findByLabelText("Notify me about direct messages");
    fireEvent.click(box);

    expect(await screen.findByText(/Your desktop refused notifications/)).toBeTruthy();
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(localStorage.getItem("ircx.notifications")).toBeNull();
  });

  /** Turning one off is not a moment to ask permission for anything. */
  it("does not ask the desktop when a switch goes off", async () => {
    localStorage.setItem(
      "ircx.notifications",
      JSON.stringify({ highlights: true, directMessages: false }),
    );
    open();
    fireEvent.click(await screen.findByLabelText("Notify me about highlights"));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("ircx.notifications") ?? "{}").highlights).toBe(false),
    );
    expect(allowedMock).not.toHaveBeenCalled();
  });

  it("says why the list could not be read", async () => {
    ipcMock.highlightWords.mockRejectedValue("The archive could not be opened.");
    open();

    expect(await screen.findByText("The archive could not be opened.")).toBeTruthy();
  });
});
