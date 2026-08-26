import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer } from "@/types";
import { TransfersStatus } from "./TransfersPanel";

const { useTransfersMock, useDisplayedNetworkMock } = vi.hoisted(() => ({
  useTransfersMock: vi.fn(),
  useDisplayedNetworkMock: vi.fn(),
}));

vi.mock("@/store/selectors", () => ({ useTransfers: useTransfersMock }));
vi.mock("@/components/shell/connection", () => ({
  useDisplayedNetwork: useDisplayedNetworkMock,
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { acceptTransfer: vi.fn(), declineTransfer: vi.fn(), cancelTransfer: vi.fn() },
  chooseSavePath: vi.fn(),
  revealFolder: vi.fn(),
  reasonOr: (_: unknown, fallback: string) => fallback,
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
    state: "running",
    failure: null,
    started: "2026-08-26T10:00:00Z",
    message: "m1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDisplayedNetworkMock.mockReturnValue({ id: "libera" });
});

describe("the transfers status", () => {
  /** A control for a thing nobody is doing is chrome the mockup would not have
   * drawn. */
  it("is not drawn at all when nothing has ever moved", () => {
    useTransfersMock.mockReturnValue([]);
    const { container } = render(<TransfersStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("counts only what is still moving", () => {
    useTransfersMock.mockReturnValue([
      transfer(),
      transfer({ id: "t2", state: "connecting" }),
      transfer({ id: "t3", state: "done" }),
    ]);
    render(<TransfersStatus />);
    expect(screen.getByRole("button", { name: "Transfers, 2 in progress" })).toBeTruthy();
    expect(screen.getByText("2 transferring")).toBeTruthy();
  });

  /** Finished transfers stay reachable: the panel is where one that scrolled
   * out of its conversation is found again. */
  it("still opens when everything has finished", () => {
    useTransfersMock.mockReturnValue([transfer({ state: "done", at: 51_200n })]);
    render(<TransfersStatus />);
    expect(screen.getByText("Transfers")).toBeTruthy();
  });

  it("lists both directions with who each is with", () => {
    useTransfersMock.mockReturnValue([
      transfer(),
      transfer({ id: "t2", direction: "outgoing", peer: "hex", file: "notes.txt" }),
    ]);
    render(<TransfersStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Transfers, 2 in progress" }));

    const panel = screen.getByRole("dialog", { name: "Transfers" });
    expect(panel.textContent).toContain("holiday.png");
    expect(panel.textContent).toContain("from sable");
    expect(panel.textContent).toContain("notes.txt");
    expect(panel.textContent).toContain("to hex");
  });

  it("closes again on the button that opened it", () => {
    useTransfersMock.mockReturnValue([transfer()]);
    render(<TransfersStatus />);
    const button = screen.getByRole("button", { name: "Transfers, 1 in progress" });

    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: "Transfers" })).not.toBeNull();

    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: "Transfers" })).toBeNull();
  });

  it("closes on Escape", () => {
    useTransfersMock.mockReturnValue([transfer()]);
    render(<TransfersStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Transfers, 1 in progress" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Transfers" })).toBeNull();
  });
});
