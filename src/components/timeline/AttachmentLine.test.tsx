import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentLine, formatSize, peekFit } from "./AttachmentLine";
import { makeAttachment } from "./fixtures";

const { ipcMock } = vi.hoisted(() => ({ ipcMock: { loadPreview: vi.fn() } }));

const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn() }));

vi.mock("@/lib/ipc", () => ({
  ipc: ipcMock,
  onIrcxEvent: vi.fn(),
  openExternal: openExternalMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  openExternalMock.mockResolvedValue(undefined);
});

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

/** The scroller, not the window: it starts under the header and ends at the composer. */
const SCROLLER = { top: 84, bottom: 597 };

describe("peekFit", () => {
  it("opens downwards from a line near the top of the scroller", () => {
    expect(peekFit({ top: 100, bottom: 118 }, SCROLLER).side).toBe("bottom");
  });

  it("opens upwards from the last line in the scroller", () => {
    expect(peekFit({ top: 570, bottom: 588 }, SCROLLER).side).toBe("top");
  });

  /**
   * The window is not the box. This line has 307px under it in a 713px window
   * and only 191px inside the scroller, which is less than the 302px above it.
   */
  it("does not count room the composer is standing on", () => {
    expect(peekFit({ top: 386, bottom: 406 }, SCROLLER).side).toBe("top");
  });

  it("takes its full height where there is room for it", () => {
    expect(peekFit({ top: 100, bottom: 118 }, SCROLLER).maxHeight).toBe(320);
  });

  /**
   * A split pane can be shorter than the image on either side of the line, and
   * #6 in the walk had the peek 105px through the bottom of the scroller.
   */
  it("cuts the peek down to a scroller too short to hold it", () => {
    expect(peekFit({ top: 241, bottom: 259 }, { top: 84, bottom: 444 })).toEqual({
      side: "bottom",
      maxHeight: 169,
    });
  });

  it("stops shrinking rather than draw a strip", () => {
    expect(peekFit({ top: 100, bottom: 118 }, { top: 84, bottom: 150 }).maxHeight).toBe(96);
  });
});

/** The peek opens on the span wrapping the filename, which is what hover reaches. */
function filenameAnchor(name = "burp-req.png") {
  return screen.getByText(name).parentElement!;
}

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

    await waitFor(() => expect(screen.getByText(/^· fetched \d\d:\d\d$/)).toBeTruthy());
    expect(ipcMock.loadPreview).toHaveBeenCalledWith("https://files.example/burp-req.png");

    fireEvent.pointerEnter(filenameAnchor());
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("keeps a loaded preview off the line until it is hovered", () => {
    render(
      <AttachmentLine
        attachment={makeAttachment({
          preview: { dataUri: "data:image/png;base64,BBBB", width: 8, height: 8 },
        })}
      />,
    );

    expect(document.querySelector("img")).toBe(null);
    expect(screen.queryByText("fetch")).toBe(null);

    fireEvent.pointerEnter(filenameAnchor());
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,BBBB",
    );

    fireEvent.pointerLeave(filenameAnchor());
    expect(document.querySelector("img")).toBe(null);
  });

  /** Tab reaches the filename, so the preview cannot be pointer-only. */
  it("peeks on focus too", () => {
    render(
      <AttachmentLine
        attachment={makeAttachment({
          preview: { dataUri: "data:image/png;base64,BBBB", width: 8, height: 8 },
        })}
      />,
    );

    fireEvent.focus(screen.getByText("burp-req.png"));
    expect(document.querySelector("img")).toBeTruthy();
  });

  it("offers no peek before anything is fetched", () => {
    render(<AttachmentLine attachment={makeAttachment()} />);

    fireEvent.pointerEnter(filenameAnchor());
    expect(document.querySelector("img")).toBe(null);
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

});

/**
 * The opener refuses a URL its capability does not cover, and until #167 that
 * was every `https://` link. The only report was a `console.warn`, which is
 * invisible to anyone not holding devtools open — so a link that did nothing
 * was indistinguishable from one that had not been clicked.
 */
describe("a link that will not open", () => {
  it("says so where the reader is looking", async () => {
    openExternalMock.mockRejectedValue(new Error("url not allowed on the configured scope"));
    render(<AttachmentLine attachment={makeAttachment()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("burp-req.png"));
    });

    expect(screen.getByText(/could not open/)).toBeTruthy();
    expect(screen.getByText(/not allowed on the configured scope/)).toBeTruthy();
  });

  it("says nothing when it opens", async () => {
    render(<AttachmentLine attachment={makeAttachment()} />);

    await act(async () => {
      fireEvent.click(screen.getByText("burp-req.png"));
    });

    expect(screen.queryByText(/could not open/)).toBeNull();
  });
});
