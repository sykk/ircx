import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { oneView, resetStore } from "@/components/shell/fixtures";
import { DropToUpload } from "../DropToUpload";

const { ipcMock, drops } = vi.hoisted(() => ({
  ipcMock: {
    getUploadProvider: vi.fn(),
    describeUploads: vi.fn(),
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
  ipcMock.describeUploads.mockImplementation((paths: string[]) =>
    Promise.resolve(
      paths.map((path) => ({
        path,
        name: path.split("/").pop(),
        bytes: 2_500_000,
        tooLarge: false,
        unreadable: null,
      })),
    ),
  );
  ipcMock.uploadFile.mockResolvedValue({
    link: "https://files.example.com/ab-photo.png",
    unreadable: null,
  });
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
    await screen.findByText("files.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

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
    // The button is offered only once the file is described and the provider
    // read, which is two answers rather than one.
    await screen.findByText("files.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

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

describe("what the confirmation says about the file", () => {
  it("names its size, so the reader knows what is leaving", async () => {
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);

    expect(await screen.findByText("2.4 MB")).toBeTruthy();
  });

  /** Offering the button anyway would make the refusal something the user
   * finds out after agreeing to it. */
  it("refuses a file over the cap before it is agreed to", async () => {
    ipcMock.describeUploads.mockResolvedValue([
      {
        path: "/home/sable/disc.iso",
        name: "disc.iso",
        bytes: 4_000_000_000,
        tooLarge: true,
        unreadable: null,
      },
    ]);
    render(<DropToUpload />);
    drop(["/home/sable/disc.iso"]);

    expect(await screen.findByText("too large")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload" })).toHaveProperty("disabled", true);
    expect(ipcMock.uploadFile).not.toHaveBeenCalled();
  });

  /** A file that went away between the drop and the confirmation. */
  it("says which file cannot be read rather than failing them all", async () => {
    ipcMock.describeUploads.mockResolvedValue([
      { path: "/a/one.png", name: "one.png", bytes: 1024, tooLarge: false, unreadable: null },
      {
        path: "/a/gone.png",
        name: "gone.png",
        bytes: 0,
        tooLarge: false,
        unreadable: "No such file",
      },
    ]);
    render(<DropToUpload />);
    drop(["/a/one.png", "/a/gone.png"]);

    expect(await screen.findByText("cannot be read")).toBeTruthy();
    expect(screen.getByText("1 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload" })).toHaveProperty("disabled", true);
  });
});

/** #90. A stored file is not a readable one: an S3 bucket is private until
 * somebody makes it otherwise, so an upload can succeed and hand back an
 * address that opens for nobody. Found by walking one against MinIO. */
describe("an address that will not open", () => {
  const WHY =
    "The file was stored, but the address is not public (403), so this link will not open " +
    "for anyone you send it to.";

  beforeEach(() => {
    ipcMock.uploadFile.mockResolvedValue({
      link: "https://s3.example.com/bucket/ab-photo.png",
      unreadable: WHY,
    });
  });

  /** The Upload button is disabled until the provider has been read, so the
   * host appearing is what says the click will land. */
  async function dropAndConfirm() {
    render(<DropToUpload />);
    drop(["/home/sable/photo.png"]);
    await screen.findByText("files.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  }

  it("is not sent, and says why", async () => {
    await dropAndConfirm();

    expect(await screen.findByText(WHY)).toBeTruthy();
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
  });

  /** Shown in full, because the file is there and the address is worth keeping
   * once the bucket is fixed. */
  it("shows the address it did not send", async () => {
    await dropAndConfirm();

    expect(
      await screen.findByText("https://s3.example.com/bucket/ab-photo.png"),
    ).toBeTruthy();
  });

  /** The client is wrong about this sometimes — a provider can serve a link it
   * refuses a HEAD for — so the reader is told, not overruled. */
  it("can be sent anyway", async () => {
    await dropAndConfirm();
    fireEvent.click(await screen.findByRole("button", { name: "Send it anyway" }));

    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        "https://s3.example.com/bucket/ab-photo.png",
      ),
    );
  });
});
