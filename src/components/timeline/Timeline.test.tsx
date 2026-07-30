import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { ESTIMATED_ROW_PX, Timeline } from "./Timeline";
import { makeAttachment, makeConversation, makeMessage } from "./fixtures";
import { formatClock } from "./rows";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: { loadHistory: vi.fn(), loadPreview: vi.fn(), submitInput: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn() }));

const KEY = targetKey("libera", "#ctf-ops");

beforeAll(() => {
  // The virtualiser sizes the viewport and every row from offsetHeight, which
  // jsdom reports as zero; a zero viewport renders no rows at all. Rows measure
  // at exactly the estimate so total heights stay predictable arithmetic.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? ESTIMATED_ROW_PX : 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  // jsdom reports scrollHeight as zero. For the scroller it is the height of
  // the virtualiser's sizer, which does carry a real inline height.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.firstElementChild as HTMLElement | null;
      const declared = sizer?.style.height;
      return declared ? Number.parseFloat(declared) : this.offsetHeight;
    },
  });
});

function seed(messages: ChatMessage[], unreadFrom: string | null = null) {
  useAppStore.setState({
    active: { network: "libera", target: "#ctf-ops" },
    networks: {
      libera: {
        id: "libera",
        name: "Libera.Chat",
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        status: { state: "connected" },
        currentNick: "sable",
        sasl: { state: "notConfigured" },
        capsEnabled: [],
        lagMs: null,
      },
    },
    timelines: {
      [KEY]: { messages, unreadFrom, hasMore: true, loadingOlder: false },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.loadHistory.mockResolvedValue([]);
  useAppStore.setState({ active: null, networks: {}, timelines: {}, typing: {} });
});

describe("Timeline", () => {
  it("says so when nothing is open", () => {
    render(<Timeline />);
    expect(screen.getByText("No conversation open")).toBeTruthy();
  });

  it("prints one gutter time per minute, over as many speakers as it holds", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "a", nick: "sable", text: "first", timestamp: new Date(base).toISOString() }),
      makeMessage({ id: "b", nick: "phrack", text: "second", timestamp: new Date(base + 1000).toISOString() }),
      makeMessage({ id: "c", nick: "nyx", text: "third", timestamp: new Date(base + 61_000).toISOString() }),
    ]);
    render(<Timeline />);

    const clocks = document.querySelectorAll("time");
    expect(clocks).toHaveLength(2);
    expect(clocks[0]!.textContent).toBe(formatClock(new Date(base).toISOString()));
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("names the author of every line, including a repeat inside one block", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "a", nick: "kade", text: "first", timestamp: new Date(base).toISOString() }),
      makeMessage({ id: "b", nick: "kade", text: "second", timestamp: new Date(base + 1000).toISOString() }),
    ]);
    render(<Timeline />);

    expect(screen.getAllByText("kade")).toHaveLength(2);
    expect(document.querySelectorAll("time")).toHaveLength(1);
  });

  it("rules off each day it has messages for", () => {
    seed([
      makeMessage({ id: "a", text: "late", timestamp: new Date(2026, 6, 28, 23, 55).toISOString() }),
      makeMessage({ id: "b", text: "early", timestamp: new Date(2026, 6, 29, 0, 5).toISOString() }),
    ]);
    render(<Timeline />);

    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("states the size of what was missed at the unread rule", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed(
      [
        makeMessage({ id: "a", text: "read", timestamp: new Date(base).toISOString() }),
        makeMessage({
          id: "b",
          nick: "phrack",
          text: "sable: the box is shared",
          timestamp: new Date(base + 1000).toISOString(),
        }),
        makeMessage({
          id: "c",
          nick: "nyx",
          text: "agreed",
          timestamp: new Date(base + 45 * 60_000).toISOString(),
        }),
      ],
      "b",
    );
    render(<Timeline />);
    expect(
      screen.getByText("2 messages, 2 people, 45 minutes · 1 of them mentions you"),
    ).toBeTruthy();
  });

  it("marks a message that mentions the user and leaves a longer nick alone", () => {
    seed([
      makeMessage({ id: "a", nick: "phrack", text: "sable: look at this" }),
      makeMessage({ id: "b", nick: "phrack", text: "sableton is a different person" }),
    ]);
    render(<Timeline />);

    const mention = document.querySelector('[data-msgid="a"]');
    const other = document.querySelector('[data-msgid="b"]');
    expect(mention?.getAttribute("data-highlight")).toBe("true");
    expect(other?.getAttribute("data-highlight")).toBe(null);
  });

  it("renders markdown as elements, never as markup", () => {
    seed([makeMessage({ id: "a", text: "**bold** and <b>not a tag</b>" })]);
    render(<Timeline />);

    const row = document.querySelector('[data-msgid="a"]')!;
    expect(within(row as HTMLElement).getByText("bold").tagName).toBe("STRONG");
    expect(row.querySelector("b")).toBe(null);
    expect(row.textContent).toContain("<b>not a tag</b>");
  });

  it("digests a burst of joins and parts into one line, expandable in place", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed(
      Array.from({ length: 7 }, (_, i) =>
        makeMessage({
          id: `s${i}`,
          nick: `user${i}`,
          kind: "join",
          text: "",
          timestamp: new Date(base + i * 1000).toISOString(),
        }),
      ),
    );
    render(<Timeline />);

    expect(screen.getByText("7 joined")).toBeTruthy();
    expect(screen.queryByText("user0 joined")).toBe(null);

    fireEvent.click(screen.getByText("show all"));
    expect(screen.getByText("user0 joined")).toBeTruthy();
  });

  it("names an access change in the digest and never hides it", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "j", nick: "kade", kind: "join", text: "", timestamp: new Date(base).toISOString() }),
      makeMessage({
        id: "m",
        nick: "ChanServ",
        kind: "mode",
        text: "ChanServ set +o kade",
        timestamp: new Date(base + 1000).toISOString(),
      }),
      makeMessage({
        id: "q",
        nick: "wren",
        kind: "quit",
        text: "",
        timestamp: new Date(base + 2000).toISOString(),
      }),
    ]);
    render(<Timeline />);

    // Present with the fold shut, and still present once it opens.
    expect(screen.getByText(/ChanServ set \+o kade/)).toBeTruthy();
    fireEvent.click(screen.getByText("show all"));
    expect(screen.getByText(/ChanServ set \+o kade/)).toBeTruthy();
    expect(screen.getByText("kade joined")).toBeTruthy();
  });

  it("bounds a paste and states its length", () => {
    seed([makeMessage({ id: "a", text: "```py\nx = 1\ny = 2\nz = 3\n```" })]);
    render(<Timeline />);

    expect(screen.getByText("3 lines")).toBeTruthy();
    expect(screen.getByText("py")).toBeTruthy();
  });

  it("shows a reply stub when the parent is outside the window", () => {
    seed([makeMessage({ id: "a", text: "answer", replyTo: "older-msgid" })]);
    render(<Timeline />);
    expect(screen.getByText("in reply to older-msgid")).toBeTruthy();
  });

  it("quotes the parent when it is loaded", () => {
    seed([
      makeMessage({ id: "a", nick: "sable", text: "the question" }),
      makeMessage({ id: "b", nick: "phrack", text: "the answer", replyTo: "a" }),
    ]);
    render(<Timeline />);

    const quote = screen.getByTitle("the question");
    expect(quote.textContent).toContain("the question");
  });

  it("renders a slice of a long conversation rather than all of it", () => {
    seed(makeConversation({ count: 4000 }));
    render(<Timeline />);
    const rendered = document.querySelectorAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(80);
  });

  it("keeps the viewport still when a page of history is prepended", async () => {
    const older = makeConversation({
      count: 200,
      seed: 7,
      startedAt: Date.parse("2026-07-28T00:00:00.000Z"),
    }).map((m) => ({ ...m, id: `old-${m.id}` }));
    ipcMock.loadHistory.mockResolvedValue(older);

    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline />);

    const scroller = screen.getByTestId("timeline-scroller");
    const heightBefore = scroller.scrollHeight;
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );

    expect(ipcMock.loadHistory).toHaveBeenCalledTimes(1);
    const grew = scroller.scrollHeight - heightBefore;
    expect(grew).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(100 + grew);
  });

  it("keeps the viewport still when the prepended page merges into the top block", async () => {
    // The page that arrives ends inside the same minute as the message that is
    // currently first, so the top block absorbs it and its membership changes
    // under the virtualiser. Anchoring reads message identity, not row
    // identity, which is the only reason that still holds.
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    const stamp = (ms: number) => new Date(base + ms).toISOString();
    const older = Array.from({ length: 200 }, (_, i) =>
      makeMessage({ id: `o${i}`, nick: "phrack", text: `older ${i}`, timestamp: stamp(5_000 - (199 - i) * 30_000) }),
    );
    ipcMock.loadHistory.mockResolvedValue(older);

    seed(
      Array.from({ length: 400 }, (_, i) =>
        makeMessage({ id: `m${i}`, nick: "sable", text: `line ${i}`, timestamp: stamp(10_000 + i * 30_000) }),
      ),
    );
    render(<Timeline />);

    const scroller = screen.getByTestId("timeline-scroller");
    const heightBefore = scroller.scrollHeight;
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );

    const grew = scroller.scrollHeight - heightBefore;
    expect(grew).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(100 + grew);
  });

  it("asks for history from before the oldest message it holds", async () => {
    const messages = makeConversation({ count: 50, seed: 5 });
    seed(messages);
    render(<Timeline />);

    fireEvent.scroll(screen.getByTestId("timeline-scroller"));

    await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalled());
    expect(ipcMock.loadHistory).toHaveBeenCalledWith({
      network: "libera",
      target: "#ctf-ops",
      before: messages[0]!.timestamp,
      limit: 200,
    });
  });

  it("dims a pending message and offers a retry on a failed one", () => {
    seed([
      makeMessage({ id: "a", text: "in flight", delivery: { state: "pending" } }),
      makeMessage({
        id: "b",
        nick: "phrack",
        text: "rejected",
        delivery: { state: "failed", detail: "Cannot send to channel" },
      }),
    ]);
    render(<Timeline />);

    expect((document.querySelector('[data-msgid="a"]') as HTMLElement).style.opacity).toBe("0.55");
    expect(screen.getByText("Not sent — Cannot send to channel")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("does not fetch an attachment before the user asks", () => {
    seed([makeMessage({ id: "a", text: "here", attachments: [makeAttachment()] })]);
    render(<Timeline />);

    expect(screen.getByText("burp-req.png")).toBeTruthy();
    expect(screen.getByText("fetch")).toBeTruthy();
    expect(document.querySelector("img")).toBe(null);
  });
});
