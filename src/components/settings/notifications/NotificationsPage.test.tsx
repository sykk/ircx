import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import type * as Ipc from "@/lib/ipc";
import { NotificationsPage } from "./NotificationsPage";

const { ipcMock, announceMock } = vi.hoisted(() => ({
  ipcMock: {
    highlightWords: vi.fn(),
    setHighlightWords: vi.fn(),
  },
  announceMock: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: ipcMock,
  onIrcxEvent: vi.fn(),
}));

vi.mock("@/lib/highlights", () => ({ announceHighlightWords: announceMock }));

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  ipcMock.highlightWords.mockResolvedValue([]);
  ipcMock.setHighlightWords.mockResolvedValue(undefined);
  announceMock.mockResolvedValue(undefined);
});

const done = vi.fn();

function open() {
  render(<NotificationsPage onDone={done} />);
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

  /** The client is drawing a conversation against the old list until it hears,
   * and it is a second webview with no way to know otherwise. */
  it("tells the other window", async () => {
    open();
    await type("deploy");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(announceMock).toHaveBeenCalled());
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

  it("says why the list could not be read", async () => {
    ipcMock.highlightWords.mockRejectedValue("The archive could not be opened.");
    open();

    expect(await screen.findByText("The archive could not be opened.")).toBeTruthy();
  });
});
