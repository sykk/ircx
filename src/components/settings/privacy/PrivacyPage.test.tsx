import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { formatBytes } from "@/lib/bytes";
import type * as Ipc from "@/lib/ipc";
import type { SettingsScope } from "@/components/settings/scope";
import { PrivacyPage, describeKept, nowKeeping } from "./PrivacyPage";

const summary = vi.fn();
const setRetention = vi.fn();
const deleteArchive = vi.fn();
const exportArchive = vi.fn();
/** This sheet is one of the two that says something when a thing went right,
 * and the only way that reaches a screen reader is the side channel. */
const announce = vi.fn();

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: {
    archiveSummary: (...args: unknown[]) => summary(...args),
    setRetention: (...args: unknown[]) => setRetention(...args),
    deleteArchive: (...args: unknown[]) => deleteArchive(...args),
    exportArchive: (...args: unknown[]) => exportArchive(...args),
    announce: (...args: unknown[]) => announce(...args),
  },
}));

/** Answered per test: dismissed by default, a path where one is wanted. */
const save = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...args: unknown[]) => save(...args) }));

const KEPT = {
  messages: 4812n,
  bytes: 3_250_000n,
  networkDays: null,
  targetDays: null,
  targetOverride: false,
  removedOnLaunch: 0n,
};

beforeEach(() => {
  summary.mockReset().mockResolvedValue(KEPT);
  setRetention.mockReset().mockResolvedValue(undefined);
  deleteArchive.mockReset().mockResolvedValue(undefined);
  exportArchive.mockReset().mockResolvedValue(120n);
  announce.mockReset().mockResolvedValue(undefined);
  save.mockReset().mockResolvedValue(null);
  resetStore();
});

/** The conversation the client was on when the window was asked for. This page
 * has no store to read it from — the settings window runs no event bridge — so
 * it is handed over. */
const HERE: SettingsScope = {
  network: "libera",
  networkName: "Libera.Chat",
  target: "#ctf-ops",
};

const done = vi.fn();

function render_(here: SettingsScope | null = HERE) {
  return render(<PrivacyPage here={here} onDone={done} />);
}

describe("saying what is kept", () => {
  it("counts messages and weighs the file", () => {
    expect(describeKept(KEPT)).toBe("4,812 messages, 3.1 MB");
  });

  it("reads a small archive in bytes rather than in 0.0 MB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("says one message without an s", () => {
    expect(describeKept({ ...KEPT, messages: 1n, bytes: 2048n })).toBe("1 message, 2.0 KB");
  });
});

/** #249. Messages still arrive and are still drawn, so a conversation that
 * empties when the app closes reads as a bug unless the page says otherwise. */
describe("what a window means", () => {
  it("says what keeping nothing does, and what it does not", () => {
    const said = nowKeeping("0");
    expect(said).toContain("Nothing is written down");
    expect(said).toContain("still drawn");
  });

  it("says forever means nothing goes", () => {
    expect(nowKeeping("")).toContain("Nothing is removed");
  });

  it("says when a window takes effect", () => {
    expect(nowKeeping("30")).toContain("next launch");
  });
});

describe("the privacy page", () => {
  /** Pruning happens before any console exists, so this screen is where the
   * window's effect is reported at all. */
  it("says what the window took on the way in", async () => {
    summary.mockResolvedValue({ ...KEPT, removedOnLaunch: 1204n });
    render_();

    expect(await screen.findByText(/1,204 were removed when ircx started/)).toBeTruthy();
  });

  it("says nothing about pruning when nothing was pruned", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    expect(screen.queryByText(/were removed when ircx started/)).toBeNull();
  });

  it("says how much is kept", async () => {
    render_();
    expect(await screen.findByText(/4,812 messages, 3.1 MB on this machine/)).toBeTruthy();
  });

  /** The whole point of showing the count beside the setting. */
  it("re-reads what is kept after a window changes", async () => {
    render_();
    await screen.findByText(/4,812 messages/);
    summary.mockClear();

    fireEvent.change(screen.getByLabelText(/Everything on Libera.Chat/), { target: { value: "30" } });

    await waitFor(() => expect(setRetention).toHaveBeenCalledWith("libera", null, 30));
    await waitFor(() => expect(summary).toHaveBeenCalled());
  });

  it("can be told to keep nothing at all", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.change(screen.getByLabelText(/Everything on Libera.Chat/), {
      target: { value: "0" },
    });

    await waitFor(() => expect(setRetention).toHaveBeenCalledWith("libera", null, 0));
    expect(await screen.findByText(/Nothing is written down/)).toBeTruthy();
  });

  it("sets a window on the conversation without touching the network's", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.change(screen.getByLabelText(/#ctf-ops, if it should differ/), {
      target: { value: "7" },
    });

    await waitFor(() => expect(setRetention).toHaveBeenCalledWith("libera", "#ctf-ops", 7));
  });

  /** Nothing is destroyed on one click. */
  it("asks before deleting, and deletes nothing until it is answered", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete everything"));
    expect(deleteArchive).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");

    fireEvent.click(within(confirm).getByText("Delete"));
    await waitFor(() => expect(deleteArchive).toHaveBeenCalledWith({ type: "everything" }));
  });

  it("takes no for an answer", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete everything"));
    fireEvent.click(screen.getByText("Keep it"));

    expect(deleteArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("names the conversation it is about to delete", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete #ctf-ops"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByText("Delete"));

    await waitFor(() =>
      expect(deleteArchive).toHaveBeenCalledWith({
        type: "conversation",
        network: "libera",
        target: "#ctf-ops",
      }),
    );
  });

  /** A file dialog nobody answers writes nothing. */
  it("writes nothing when the save dialog is dismissed", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Export everything"));

    await waitFor(() => expect(exportArchive).not.toHaveBeenCalled());
  });

  /**
   * The run in `docs/end-to-end-run-5.md` met this: an export written, then a
   * second aimed at a folder that refused it, and the sheet held both at once.
   */
  it("drops the last success when the next export fails", async () => {
    save.mockResolvedValue("/tmp/first.jsonl");
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Export everything"));
    await screen.findByText(/Written to \/tmp\/first.jsonl/);

    save.mockResolvedValue("/read-only/second.jsonl");
    exportArchive.mockRejectedValue(
      "/read-only/second.jsonl could not be written: there is no permission to write there",
    );
    fireEvent.click(screen.getByText("Export everything"));

    await screen.findByText(/there is no permission to write there/);
    expect(screen.queryByText(/Written to/)).toBeNull();
  });

  /** The other way round: the failure goes when the next one works. */
  it("drops the last failure when the next export works", async () => {
    save.mockResolvedValue("/read-only/first.jsonl");
    exportArchive.mockRejectedValue("/read-only/first.jsonl could not be written: that disk is read-only");
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Export everything"));
    await screen.findByText(/that disk is read-only/);

    save.mockResolvedValue("/tmp/second.jsonl");
    exportArchive.mockResolvedValue(120n);
    fireEvent.click(screen.getByText("Export everything"));

    await screen.findByText(/Written to \/tmp\/second.jsonl/);
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  /**
   * The sheet routed its `role="alert"` through `useAnnounce` and left its
   * `role="status"` on the markup alone, so every way of failing spoke and
   * nothing that worked did. In this window that is silence rather than a
   * quieter announcement: WebKitGTK reports nothing for text the page rewrites,
   * which is what the status paragraph is.
   */
  it("says an export worked, rather than only drawing that it did", async () => {
    save.mockResolvedValue("/tmp/export.jsonl");
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Export everything"));

    await screen.findByText(/Written to \/tmp\/export.jsonl/);
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith("Written to /tmp/export.jsonl — 120 B."),
    );
  });

  /** The one on this sheet that cannot be undone, and the one it most matters
   * to have heard. */
  it("says the archive was deleted", async () => {
    render_();
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete everything"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByText("Delete"));

    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith(
        "The whole archive deleted. There is no undo, and there was none.",
      ),
    );
  });
});
