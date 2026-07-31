import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentLine, formatSize } from "./AttachmentLine";
import { makeAttachment } from "./fixtures";

const { ipcMock } = vi.hoisted(() => ({ ipcMock: { loadPreview: vi.fn() } }));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  onIrcxEvent: vi.fn(),
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => vi.clearAllMocks());

describe("formatSize", () => {
  it("scales to the largest unit that stays readable", () => {
    expect(formatSize(512n)).toBe("512 B");
    expect(formatSize(411_648n)).toBe("402 KB");
    expect(formatSize(1_153_433n)).toBe("1.1 MB");
  });

  it("returns nothing when the server did not say", () => {
    expect(formatSize(null)).toBe(null);
  });
});

describe("AttachmentLine", () => {
  it("shows the file without touching the network", () => {
    render(<AttachmentLine attachment={makeAttachment()} />);

    expect(screen.getByText("burp-req.png")).toBeTruthy();
    expect(screen.getByText("1.1 MB")).toBeTruthy();
    expect(screen.getByText("fetch")).toBeTruthy();
    expect(ipcMock.loadPreview).not.toHaveBeenCalled();
  });

  it("fetches only once the user clicks", async () => {
    ipcMock.loadPreview.mockResolvedValue(
      makeAttachment({ preview: { dataUri: "data:image/png;base64,AAAA", width: 4, height: 4 } }),
    );
    render(<AttachmentLine attachment={makeAttachment()} />);

    fireEvent.click(screen.getByText("fetch"));

    await waitFor(() => expect(document.querySelector("img")).toBeTruthy());
    expect(ipcMock.loadPreview).toHaveBeenCalledWith("https://files.example/burp-req.png");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(screen.getByText(/^· fetched \d\d:\d\d$/)).toBeTruthy();
  });

  it("renders an already-loaded preview without a control", () => {
    render(
      <AttachmentLine
        attachment={makeAttachment({
          preview: { dataUri: "data:image/png;base64,BBBB", width: 8, height: 8 },
        })}
      />,
    );

    expect(document.querySelector("img")).toBeTruthy();
    expect(screen.queryByText("fetch")).toBe(null);
  });

  it("falls back to the last path segment when there is no filename", () => {
    render(
      <AttachmentLine
        attachment={makeAttachment({
          filename: null,
          url: "https://files.example/a/b/dump.bin?sig=1",
        })}
      />,
    );
    expect(screen.getByText("dump.bin")).toBeTruthy();
  });
});

/**
 * Every URL in a message is an attachment, and only four image formats can be
 * shown. Offering `fetch` on the rest is an action whose only possible answer
 * is that it is not an image.
 */
describe("what a preview is offered for", () => {
  it("offers nothing for a URL that is not an image", () => {
    render(
      <AttachmentLine
        attachment={makeAttachment({
          url: "https://example.invalid/an/article",
          filename: "article",
          mime: null,
          sizeBytes: null,
        })}
      />,
    );

    expect(screen.queryByText("fetch")).toBeNull();
    expect(screen.getByText("article")).toBeTruthy();
  });

  it("still offers one for an image", () => {
    render(<AttachmentLine attachment={makeAttachment()} />);
    expect(screen.getByText("fetch")).toBeTruthy();
  });
});
