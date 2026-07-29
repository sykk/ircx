import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentCard, formatSize } from "./AttachmentCard";
import { makeAttachment } from "./fixtures";

const { ipcMock } = vi.hoisted(() => ({ ipcMock: { loadPreview: vi.fn() } }));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn() }));

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

describe("AttachmentCard", () => {
  it("shows the file without touching the network", () => {
    render(<AttachmentCard attachment={makeAttachment()} />);

    expect(screen.getByText("burp-req.png")).toBeTruthy();
    expect(screen.getByText("1.1 MB · png")).toBeTruthy();
    expect(screen.getByText("Load preview")).toBeTruthy();
    expect(ipcMock.loadPreview).not.toHaveBeenCalled();
  });

  it("fetches only once the user clicks", async () => {
    ipcMock.loadPreview.mockResolvedValue(
      makeAttachment({ preview: { dataUri: "data:image/png;base64,AAAA", width: 4, height: 4 } }),
    );
    render(<AttachmentCard attachment={makeAttachment()} />);

    fireEvent.click(screen.getByText("Load preview"));

    await waitFor(() => expect(document.querySelector("img")).toBeTruthy());
    expect(ipcMock.loadPreview).toHaveBeenCalledWith("https://files.example/burp-req.png");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("renders an already-loaded preview without a control", () => {
    render(
      <AttachmentCard
        attachment={makeAttachment({
          preview: { dataUri: "data:image/png;base64,BBBB", width: 8, height: 8 },
        })}
      />,
    );

    expect(document.querySelector("img")).toBeTruthy();
    expect(screen.queryByText("Load preview")).toBe(null);
  });

  it("falls back to the last path segment when there is no filename", () => {
    render(
      <AttachmentCard
        attachment={makeAttachment({
          filename: null,
          url: "https://files.example/a/b/dump.bin?sig=1",
        })}
      />,
    );
    expect(screen.getByText("dump.bin")).toBeTruthy();
  });
});
