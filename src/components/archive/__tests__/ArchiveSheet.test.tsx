import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { makeNetwork, oneView } from "@/components/shell/fixtures";
import { ArchiveSheet, describeKept, describeSize } from "../ArchiveSheet";

const summary = vi.fn();
const setRetention = vi.fn();
const deleteArchive = vi.fn();
const exportArchive = vi.fn();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    archiveSummary: (...args: unknown[]) => summary(...args),
    setRetention: (...args: unknown[]) => setRetention(...args),
    deleteArchive: (...args: unknown[]) => deleteArchive(...args),
    exportArchive: (...args: unknown[]) => exportArchive(...args),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: () => Promise.resolve(null) }));

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
  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
    networks: { libera: makeNetwork("libera", { name: "Libera.Chat" }) },
    archiveOpen: true,
  });
});

describe("saying what is kept", () => {
  it("counts messages and weighs the file", () => {
    expect(describeKept(KEPT)).toBe("4,812 messages, 3.1 MB");
  });

  it("reads a small archive in bytes rather than in 0.0 MB", () => {
    expect(describeSize(512)).toBe("512 B");
  });

  it("says one message without an s", () => {
    expect(describeKept({ ...KEPT, messages: 1n, bytes: 2048n })).toBe("1 message, 2.0 kB");
  });
});

describe("the archive sheet", () => {
  it("draws nothing while it is closed", () => {
    useAppStore.setState({ archiveOpen: false });
    const { container } = render(<ArchiveSheet />);
    expect(container.innerHTML).toBe("");
  });

  /** Pruning happens before any console exists, so this screen is where the
   * window's effect is reported at all. */
  it("says what the window took on the way in", async () => {
    summary.mockResolvedValue({ ...KEPT, removedOnLaunch: 1204n });
    render(<ArchiveSheet />);

    expect(await screen.findByText(/1,204 were removed when ircx started/)).toBeTruthy();
  });

  it("says nothing about pruning when nothing was pruned", async () => {
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);

    expect(screen.queryByText(/were removed when ircx started/)).toBeNull();
  });

  it("says how much is kept", async () => {
    render(<ArchiveSheet />);
    expect(await screen.findByText(/4,812 messages, 3.1 MB on this machine/)).toBeTruthy();
  });

  /** The whole point of showing the count beside the setting. */
  it("re-reads what is kept after a window changes", async () => {
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);
    summary.mockClear();

    fireEvent.change(screen.getByLabelText(/Everything on Libera.Chat/), { target: { value: "30" } });

    await waitFor(() => expect(setRetention).toHaveBeenCalledWith("libera", null, 30));
    await waitFor(() => expect(summary).toHaveBeenCalled());
  });

  it("sets a window on the conversation without touching the network's", async () => {
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);

    fireEvent.change(screen.getByLabelText(/#ctf-ops, if it should differ/), {
      target: { value: "7" },
    });

    await waitFor(() => expect(setRetention).toHaveBeenCalledWith("libera", "#ctf-ops", 7));
  });

  /** Nothing is destroyed on one click. */
  it("asks before deleting, and deletes nothing until it is answered", async () => {
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete everything"));
    expect(deleteArchive).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");

    fireEvent.click(within(confirm).getByText("Delete"));
    await waitFor(() => expect(deleteArchive).toHaveBeenCalledWith({ type: "everything" }));
  });

  it("takes no for an answer", async () => {
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Delete everything"));
    fireEvent.click(screen.getByText("Keep it"));

    expect(deleteArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("names the conversation it is about to delete", async () => {
    render(<ArchiveSheet />);
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
    render(<ArchiveSheet />);
    await screen.findByText(/4,812 messages/);

    fireEvent.click(screen.getByText("Export everything"));

    await waitFor(() => expect(exportArchive).not.toHaveBeenCalled());
  });
});
