import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { oneView, resetStore } from "@/components/shell/fixtures";
import { DropToUpload } from "../DropToUpload";

const { ipcMock, drops } = vi.hoisted(() => ({
  ipcMock: {
    getUploadProvider: vi.fn(),
    uploadFile: vi.fn(),
    submitInput: vi.fn(),
  },
  drops: { handler: null as ((event: unknown) => void) | null },
}));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  onIrcxEvent: vi.fn(),
  onFileDrop: (handler: (event: unknown) => void) => {
    drops.handler = handler;
    return Promise.resolve(() => {});
  },
}));

function drop(paths: string[]) {
  act(() => drops.handler?.({ kind: "drop", paths }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  useAppStore.setState(oneView({ network: "libera", target: "#ctf-ops" }));
  ipcMock.getUploadProvider.mockResolvedValue({
    endpoint: "https://files.example.com/{name}",
    method: "PUT",
    authHeader: null,
    token: null,
  });
  ipcMock.uploadFile.mockResolvedValue("https://files.example.com/ab-photo.png");
  ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
});

describe("dropping a file on the window", () => {
  it("shows where it is about to go before anything is sent", async () => {
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);

    expect(await screen.findByRole("dialog", { name: "Upload" })).toBeTruthy();
    expect(screen.getByText("photo.png")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("files.example.com")).toBeTruthy());
    expect(screen.getByText("#ctf-ops")).toBeTruthy();
    expect(ipcMock.uploadFile).not.toHaveBeenCalled();
  });

  /** The consent boundary. Nothing leaves the machine on the drop itself. */
  it("sends nothing when the confirmation is cancelled", async () => {
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(ipcMock.uploadFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Upload" })).toBeNull();
  });

  it("uploads and puts the link in the conversation", async () => {
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));

    await waitFor(() =>
      expect(ipcMock.uploadFile).toHaveBeenCalledWith("/home/sable/photo.png"),
    );
    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        "https://files.example.com/ab-photo.png",
      ),
    );
  });

  /** Nowhere to send it is not something to discover after clicking Upload. */
  it("says so, and offers nothing, when no provider is configured", async () => {
    ipcMock.getUploadProvider.mockResolvedValue(null);
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);

    expect(
      await screen.findByText(/No upload provider is configured/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload" })).toHaveProperty("disabled", true);
  });

  it("shows why an upload was refused and keeps the confirmation open", async () => {
    ipcMock.uploadFile.mockRejectedValue("photo.png is 40 MB, and ircx uploads files up to 25 MB");
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);
    fireEvent.click(await screen.findByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Upload" })).toBeTruthy();
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
  });

  it("names every file when several are dropped", async () => {
    render(<DropToUpload />);
    drop(["/home/sable/one.png", "/home/sable/two.png"]);

    expect(await screen.findByText("Upload 2 files?")).toBeTruthy();
    expect(screen.getByText("one.png")).toBeTruthy();
    expect(screen.getByText("two.png")).toBeTruthy();
  });
});
