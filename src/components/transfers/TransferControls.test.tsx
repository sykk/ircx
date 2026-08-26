import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer } from "@/types";
import { progressOf, TransferControls } from "./TransferControls";

const { ipcMock, chooseSavePathMock, revealFolderMock } = vi.hoisted(() => ({
  ipcMock: {
    acceptTransfer: vi.fn(),
    declineTransfer: vi.fn(),
    cancelTransfer: vi.fn(),
  },
  chooseSavePathMock: vi.fn(),
  revealFolderMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  chooseSavePath: chooseSavePathMock,
  revealFolder: revealFolderMock,
  reasonOr: (reason: unknown, fallback: string) =>
    typeof reason === "string" && reason.trim() !== "" ? reason : fallback,
}));

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: "t1",
    network: "libera",
    peer: "sable",
    direction: "incoming",
    file: "holiday.png",
    path: null,
    size: 51_200n,
    at: 0n,
    state: "offered",
    failure: null,
    started: "2026-08-26T10:00:00Z",
    message: "m1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.acceptTransfer.mockResolvedValue(undefined);
  ipcMock.declineTransfer.mockResolvedValue(undefined);
  ipcMock.cancelTransfer.mockResolvedValue(undefined);
  revealFolderMock.mockResolvedValue(undefined);
});

describe("progressOf", () => {
  it("counts against the offered size", () => {
    expect(progressOf(transfer({ at: 2048n }))).toBe("2.0 KB of 50 KB");
  });

  /** A sender that named no size makes a proportion impossible, so the count
   * stands on its own rather than against a total nobody gave. */
  it("says only how much arrived when the offer named no size", () => {
    expect(progressOf(transfer({ size: 0n, at: 2048n }))).toBe("2.0 KB");
  });
});

describe("an offer waiting to be answered", () => {
  it("is accepted into the download folder without asking where", async () => {
    render(<TransferControls transfer={transfer()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(ipcMock.acceptTransfer).toHaveBeenCalledWith("libera", "t1", null),
    );
    expect(chooseSavePathMock).not.toHaveBeenCalled();
  });

  it("takes a name from the save dialog when one is asked for", async () => {
    chooseSavePathMock.mockResolvedValue("/home/sykk/elsewhere/holiday.png");
    render(<TransferControls transfer={transfer()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));

    await waitFor(() =>
      expect(ipcMock.acceptTransfer).toHaveBeenCalledWith(
        "libera",
        "t1",
        "/home/sykk/elsewhere/holiday.png",
      ),
    );
  });

  /** Dismissing the dialog is not choosing a name, and accepting anyway would
   * put the file somewhere the reader did not agree to. */
  it("accepts nothing when the save dialog is dismissed", async () => {
    chooseSavePathMock.mockResolvedValue(null);
    render(<TransferControls transfer={transfer()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));

    await waitFor(() => expect(chooseSavePathMock).toHaveBeenCalled());
    expect(ipcMock.acceptTransfer).not.toHaveBeenCalled();
  });

  it("is declined rather than left to time out", async () => {
    render(<TransferControls transfer={transfer()} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(ipcMock.declineTransfer).toHaveBeenCalledWith("libera", "t1"),
    );
  });

  it("says why the backend refused it", async () => {
    ipcMock.acceptTransfer.mockRejectedValue("/home is full");
    render(<TransferControls transfer={transfer()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "/home is full",
    );
  });
});

describe("a transfer already moving", () => {
  it("draws how far it has got and offers only the way out", () => {
    render(
      <TransferControls transfer={transfer({ state: "running", at: 25_600n })} />,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25600");
    expect(bar.getAttribute("aria-valuemax")).toBe("51200");
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("is stopped where it got to", async () => {
    render(<TransferControls transfer={transfer({ state: "running", at: 25_600n })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(ipcMock.cancelTransfer).toHaveBeenCalledWith("libera", "t1"));
  });

  /** An outgoing offer nobody has answered is still this end's to withdraw;
   * only an *incoming* one that is waiting gets accept and decline instead. */
  it("can be withdrawn while nobody has answered it", () => {
    render(
      <TransferControls
        transfer={transfer({ direction: "outgoing", state: "offered" })}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });
});

describe("a transfer that has ended", () => {
  it("offers the folder it landed in", async () => {
    render(
      <TransferControls
        transfer={transfer({
          state: "done",
          at: 51_200n,
          path: "/home/sykk/Downloads/holiday.png",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));

    await waitFor(() =>
      expect(revealFolderMock).toHaveBeenCalledWith("/home/sykk/Downloads"),
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("says why it failed", () => {
    render(
      <TransferControls
        transfer={{
          ...transfer(),
          state: "failed",
          at: 1024n,
          failure: "the connection closed after 1024 of 51200 bytes",
        }}
      />,
    );
    expect(
      screen.getByText("the connection closed after 1024 of 51200 bytes"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
