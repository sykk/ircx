import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Reaction } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ESTIMATED_ROW_PX, Timeline } from "./Timeline";
import {
  makeAttachment,
  makeConversation,
  makeMessage,
  type MessageOverrides,
} from "./fixtures";
import { formatClock } from "./rows";

const { ipcMock, openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn().mockResolvedValue(undefined),
  ipcMock: {
    loadHistory: vi.fn(),
    loadPreview: vi.fn(),
    submitInput: vi.fn(),
    react: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn(), openExternal: openExternalMock }));

const KEY = targetKey("libera", "#ctf-ops");
/** Height the history head reports, so the space it reserves is checkable. */
const HEAD_PX = 20;
/** What the scroller reports as its viewport, since jsdom lays nothing out. */
const VIEWPORT_PX = 600;

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
      if (this.hasAttribute("data-index")) return ESTIMATED_ROW_PX;
      if (this.dataset.testid === "timeline-head") return HEAD_PX;
      return VIEWPORT_PX;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  // Nothing here has a border or a scrollbar, so the padding box is the border
  // box. The virtualiser reads it to find how far down a scroller can go.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.offsetHeight;
    },
  });
  // jsdom reports scrollHeight as zero. For the scroller it is the height of
  // the virtualiser's sizer, which does carry a real inline height. The sizer
  // is found by name rather than by position: the history head is a sibling
  // above it and would otherwise be measured instead.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.querySelector<HTMLElement>('[data-testid="timeline-sizer"]');
      const declared = sizer?.style.height;
      return declared ? Number.parseFloat(declared) : this.offsetHeight;
    },
  });
});

/**
 * jsdom has no scrolling, so nothing answers the virtualiser's `scrollTo`. On
 * one scroller, and only from the point it is called, a browser's answer: move
 * `scrollTop` there. Left off elsewhere — it would also let the virtualiser's
 * own prepend compensation run, which no test here is about.
 */
function letItScroll(scroller: HTMLElement) {
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
  }) as HTMLElement["scrollTo"];
}

function seedTimelines(timelines: AppState["timelines"]) {
  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
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
    timelines,
    // Cleared with the timelines it belongs to: `setState` merges, so state
    // left by one test would apply to another's messages.
    replyTo: {},
  });
}

function seed(messages: ChatMessage[], unreadFrom: string | null = null) {
  seedTimelines({ [KEY]: { messages, unreadFrom, hasMore: true, loadingOlder: false } });
}

/** A second pane on the same channel, as a split would open, parked at
 * `scrollPosition` so it is reading history rather than following. */
function openSecondView(scrollPosition: number) {
  const id = "second-view";
  const { views, viewOrder } = useAppStore.getState();
  useAppStore.setState({
    views: { ...views, [id]: { ...views[TEST_VIEW]!, id, scrollPosition } },
    viewOrder: [...viewOrder, id],
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Opening a pane reads the archive, so every render below starts one. Left
  // in flight by default: a test that cares about the answer says what it is.
  ipcMock.loadHistory.mockReturnValue(new Promise(() => {}));
  ipcMock.react.mockResolvedValue({ kind: "handled" });
  useAppStore.setState({ ...oneView(null), networks: {}, timelines: {}, typing: {} });
});

describe("Timeline", () => {
  it("says so when nothing is open", () => {
    render(<Timeline view={null} />);
    expect(screen.getByText("No conversation open")).toBeTruthy();
  });

  it("prints one gutter time per minute, over as many speakers as it holds", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "a", nick: "sable", text: "first", timestamp: new Date(base).toISOString() }),
      makeMessage({ id: "b", nick: "phrack", text: "second", timestamp: new Date(base + 1000).toISOString() }),
      makeMessage({ id: "c", nick: "nyx", text: "third", timestamp: new Date(base + 61_000).toISOString() }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

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
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("kade")).toHaveLength(2);
    expect(document.querySelectorAll("time")).toHaveLength(1);
  });

  it("rules off each day it has messages for", () => {
    seed([
      makeMessage({ id: "a", text: "late", timestamp: new Date(2026, 6, 28, 23, 55).toISOString() }),
      makeMessage({ id: "b", text: "early", timestamp: new Date(2026, 6, 29, 0, 5).toISOString() }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

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
    render(<Timeline view={TEST_VIEW} />);
    expect(
      screen.getByText("2 messages, 2 people, 45 minutes · 1 of them mentions you"),
    ).toBeTruthy();
  });

  it("marks a message that mentions the user and leaves a longer nick alone", () => {
    seed([
      makeMessage({ id: "a", nick: "phrack", text: "sable: look at this" }),
      makeMessage({ id: "b", nick: "phrack", text: "sableton is a different person" }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const mention = document.querySelector('[data-msgid="a"]');
    const other = document.querySelector('[data-msgid="b"]');
    expect(mention?.getAttribute("data-highlight")).toBe("true");
    expect(other?.getAttribute("data-highlight")).toBe(null);
  });

  it("renders markdown as elements, never as markup", () => {
    seed([makeMessage({ id: "a", text: "**bold** and <b>not a tag</b>" })]);
    render(<Timeline view={TEST_VIEW} />);

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
    render(<Timeline view={TEST_VIEW} />);

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
    render(<Timeline view={TEST_VIEW} />);

    // Present with the fold shut, and still present once it opens.
    expect(screen.getByText(/ChanServ set \+o kade/)).toBeTruthy();
    fireEvent.click(screen.getByText("show all"));
    expect(screen.getByText(/ChanServ set \+o kade/)).toBeTruthy();
    expect(screen.getByText("kade joined")).toBeTruthy();
  });

  it("bounds a paste and states its length", () => {
    seed([makeMessage({ id: "a", text: "```py\nx = 1\ny = 2\nz = 3\n```" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("3 lines")).toBeTruthy();
    expect(screen.getByText("py")).toBeTruthy();
  });

  it("shows a reply stub when the parent is outside the window", () => {
    seed([makeMessage({ id: "a", text: "answer", replyTo: "older-msgid" })]);
    render(<Timeline view={TEST_VIEW} />);
    expect(screen.getByText("in reply to older-msgid")).toBeTruthy();
  });

  it("quotes the parent when it is loaded", () => {
    seed([
      makeMessage({ id: "a", nick: "sable", text: "the question" }),
      makeMessage({ id: "b", nick: "phrack", text: "the answer", replyTo: "a" }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const quote = screen.getByTitle("the question");
    expect(quote.textContent).toContain("the question");
  });

  it("renders a slice of a long conversation rather than all of it", () => {
    seed(makeConversation({ count: 4000 }));
    render(<Timeline view={TEST_VIEW} />);
    const rendered = document.querySelectorAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(80);
  });

  it("follows the tail when new lines merge into the row that is already open", () => {
    // A console is nothing but system messages, so a minute of output is a
    // single row and the fifteen lines a `/help` adds land inside the row
    // already on screen. Nothing about the row count changes.
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    const line = (id: string, minute: number) =>
      makeMessage({
        id,
        kind: "server",
        nick: "irc.libera.chat",
        text: `- ${id}`,
        timestamp: new Date(base + minute * 60_000).toISOString(),
      });

    seed(Array.from({ length: 20 }, (_, i) => line(`motd${i}`, i)));
    render(<Timeline view={TEST_VIEW} />);

    const scroller = screen.getByTestId("timeline-scroller");
    letItScroll(scroller);
    expect(scroller.scrollTop).toBe(0);

    act(() => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        network: "libera",
        target: "#ctf-ops",
        messages: Array.from({ length: 15 }, (_, i) => line(`help${i}`, 19)),
      });
    });

    const open = document.querySelector('[data-msgid="motd19"]')!.closest("[data-index]")!;
    expect(open.contains(document.querySelector('[data-msgid="help14"]'))).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEWPORT_PX);
  });

  it("puts the head of history in the content it labels rather than over it", () => {
    seedTimelines({
      [KEY]: {
        messages: makeConversation({ count: 20, seed: 6 }),
        unreadFrom: null,
        hasMore: false,
        loadingOlder: false,
      },
    });
    render(<Timeline view={TEST_VIEW} />);

    const head = screen.getByText("Beginning of history");
    expect(head.parentElement).toBe(screen.getByTestId("timeline-scroller"));
    expect(head.nextElementSibling).toBe(screen.getByTestId("timeline-sizer"));
    expect(head.className).not.toContain("absolute");
    // Its height is reserved once, not twice: the list begins at the top of the
    // sizer, which itself begins below the head.
    const first = document.querySelector('[data-index="0"]') as HTMLElement;
    expect(first.style.transform).toBe("translateY(0px)");
  });

  it("keeps the viewport still when a page of history is prepended", async () => {
    const older = makeConversation({
      count: 200,
      seed: 7,
      startedAt: Date.parse("2026-07-28T00:00:00.000Z"),
    }).map((m) => ({ ...m, id: `old-${m.id}` }));
    ipcMock.loadHistory.mockResolvedValue(older);

    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);

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
    render(<Timeline view={TEST_VIEW} />);

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

  it("anchors each pane on its own position when two show the same channel", async () => {
    // The anchor is per instance and keys on message identity, so a second pane
    // on the channel history arrives for has to hold its own place too.
    const older = makeConversation({
      count: 200,
      seed: 11,
      startedAt: Date.parse("2026-07-28T00:00:00.000Z"),
    }).map((m) => ({ ...m, id: `old-${m.id}` }));
    ipcMock.loadHistory.mockResolvedValue(older);

    seed(makeConversation({ count: 400, seed: 3 }));
    const second = openSecondView(200);
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );

    const [reading, other] = screen.getAllByTestId("timeline-scroller");
    const heightBefore = reading!.scrollHeight;
    reading!.scrollTop = 100;
    fireEvent.scroll(reading!);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );

    const grew = reading!.scrollHeight - heightBefore;
    expect(grew).toBeGreaterThan(0);
    expect(reading!.scrollTop).toBe(100 + grew);
    expect(other!.scrollTop).toBe(200 + grew);
  });

  it("reads the archive when a pane opens on a conversation the window holds none of", async () => {
    const stored = makeConversation({ count: 30, seed: 9 });
    ipcMock.loadHistory.mockResolvedValue(stored);
    seed([]);
    render(<Timeline view={TEST_VIEW} />);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(30),
    );
    expect(ipcMock.loadHistory).toHaveBeenCalledWith({
      network: "libera",
      target: "#ctf-ops",
      before: null,
      limit: 200,
    });
    expect(screen.queryByText("Nothing here yet")).toBe(null);
  });

  it("reads it for a channel restored with no timeline entry at all", async () => {
    // How a channel arrives after a restart: `channelUpdated` with no messages,
    // so the store holds no entry for it — not an empty one.
    const stored = makeConversation({ count: 30, seed: 4 });
    ipcMock.loadHistory.mockResolvedValue(stored);
    seedTimelines({});
    render(<Timeline view={TEST_VIEW} />);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(30),
    );
    expect(ipcMock.loadHistory).toHaveBeenCalledWith({
      network: "libera",
      target: "#ctf-ops",
      before: null,
      limit: 200,
    });
    expect(screen.queryByText("Nothing here yet")).toBe(null);
  });

  it("reads it for a pane holding only the note it was opened by", async () => {
    const note = makeMessage({ id: "j", kind: "join", nick: "sable", text: "" });
    ipcMock.loadHistory.mockResolvedValue([]);
    seed([note]);
    render(<Timeline view={TEST_VIEW} />);

    await waitFor(() =>
      expect(ipcMock.loadHistory).toHaveBeenCalledWith({
        network: "libera",
        target: "#ctf-ops",
        before: note.timestamp,
        limit: 200,
      }),
    );
  });

  it("leaves a pane with a screenful to the scroll handler", () => {
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);
    expect(ipcMock.loadHistory).not.toHaveBeenCalled();
  });

  it("asks for history from before the oldest message it holds", async () => {
    const messages = makeConversation({ count: 50, seed: 5 });
    seed(messages);
    render(<Timeline view={TEST_VIEW} />);

    fireEvent.scroll(screen.getByTestId("timeline-scroller"));

    await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalled());
    expect(ipcMock.loadHistory).toHaveBeenCalledWith({
      network: "libera",
      target: "#ctf-ops",
      before: messages[0]!.timestamp,
      limit: 200,
    });
  });

  it("draws none of the IRC formatting codes a services reply arrives with", () => {
    seed([
      makeMessage({
        id: "a",
        nick: "NickServ",
        kind: "notice",
        text: "\u0002ircx-e39169\u0002 is not registered.",
      }),
      makeMessage({
        id: "b",
        nick: "phrack",
        text: "\u000304,08red on yellow\u0003 and back",
      }),
      makeMessage({
        id: "c",
        nick: "irc.libera.chat",
        kind: "server",
        text: "\u001funderlined motd\u000f",
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const drawn = screen.getByTestId("timeline-scroller").textContent ?? "";
    expect(drawn).toContain("ircx-e39169 is not registered.");
    expect(drawn).toContain("red on yellow and back");
    expect(drawn).toContain("underlined motd");
    expect([...drawn].filter((ch) => ch.charCodeAt(0) < 0x20)).toEqual([]);
  });

  it("keeps a MOTD's own spacing, in the face its rules were drawn against", () => {
    seed([
      makeMessage({
        id: "m",
        kind: "server",
        nick: "irc.libera.chat",
        text: "-  |   |     Welcome to Libera.Chat",
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const line = document.querySelector('[data-msgid="m"]')!;
    expect(line.className).toContain("--font-mono");
    expect(line.className).toContain("whitespace-pre-wrap");
  });

  it("keeps a client line's own spacing, in the face its columns were measured for", () => {
    seed([
      makeMessage({
        id: "h",
        kind: "client",
        nick: "libera",
        text: "/join #channel [key]      join a channel",
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const line = document.querySelector('[data-msgid="h"]')!;
    expect(line.className).toContain("--font-mono");
    expect(line.className).toContain("whitespace-pre-wrap");
  });

  /** A plugin's answer is set exactly like `/help`'s. Without the name the
   * reader cannot tell what the client said from what somebody else's code said
   * in their conversation. */
  it("names the plugin an answer came from, once for the whole answer", () => {
    seed([
      makeMessage({ id: "p1", kind: "client", text: "first line", via: "roster" }),
      makeMessage({ id: "p2", kind: "client", text: "second line", via: "roster" }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("roster")).toHaveLength(1);
    expect(document.querySelector('[data-msgid="p2"]')!.textContent).toBe("second line");
  });

  it("says nothing about a plugin on the client's own output", () => {
    seed([makeMessage({ id: "h", kind: "client", text: "/help output", via: null })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(document.querySelector('[data-msgid="h"]')!.textContent).toBe("/help output");
    expect(screen.queryByText("roster")).toBeNull();
  });

  it("separates two plugins answering into runs of their own", () => {
    seed([
      makeMessage({ id: "a", kind: "client", text: "from one", via: "greet" }),
      makeMessage({ id: "b", kind: "client", text: "from the other", via: "roster" }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("greet")).toBeTruthy();
    expect(screen.getByText("roster")).toBeTruthy();
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
    render(<Timeline view={TEST_VIEW} />);

    expect((document.querySelector('[data-msgid="a"]') as HTMLElement).style.opacity).toBe("0.55");
    expect(screen.getByText("Not sent — Cannot send to channel")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("does not fetch an attachment before the user asks", () => {
    seed([makeMessage({ id: "a", text: "here", attachments: [makeAttachment()] })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("burp-req.png")).toBeTruthy();
    expect(screen.getByText("fetch")).toBeTruthy();
    expect(document.querySelector("img")).toBe(null);
  });
});

describe("reaction chips", () => {
  /** `sable` is the nick the seeded network is connected under. */
  function seedReacted(reactions: Reaction[], message: Partial<ChatMessage> = {}) {
    seed([makeMessage({ id: "123", nick: "phrack", text: "the flag is in the env", ...message })]);
    useAppStore.getState().applyEvent({
      type: "capsChanged",
      network: "libera",
      enabled: ["message-tags"],
    });
    for (const { emoji, nicks } of reactions) {
      for (const nick of nicks) {
        useAppStore.getState().applyEvent({
          type: "reactionChanged",
          network: "libera",
          target: "#ctf-ops",
          message: "123",
          nick,
          emoji,
          active: true,
        });
      }
    }
  }

  function chip(emoji: string) {
    return screen.getByRole("button", { name: new RegExp(`^${emoji} — `) });
  }

  // readability/READABILITY.md study 14: a count on its own is a popularity
  // metric. The names are the information, and your own is written as `you`.
  it("names who reacted rather than only counting them", () => {
    seedReacted([{ emoji: "🔥", nicks: ["kade", "sable", "wren"] }]);
    render(<Timeline view={TEST_VIEW} />);

    expect(chip("🔥").getAttribute("aria-label")).toBe("🔥 — kade, you, wren");
    expect(within(chip("🔥")).getByText("3")).toBeTruthy();
  });

  it("marks the one you sent and takes it back when it is clicked again", () => {
    seedReacted([
      { emoji: "🔥", nicks: ["kade", "sable"] },
      { emoji: "👀", nicks: ["wren"] },
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(chip("🔥").getAttribute("aria-pressed")).toBe("true");
    expect(chip("👀").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip("🔥"));
    expect(ipcMock.react).toHaveBeenCalledWith("libera", "#ctf-ops", "123", "🔥", false);

    fireEvent.click(chip("👀"));
    expect(ipcMock.react).toHaveBeenCalledWith("libera", "#ctf-ops", "123", "👀", true);
  });

  it("reacts by the msgid the server gave a message we sent, not the local id", () => {
    seedReacted([{ emoji: "🔥", nicks: ["kade"] }], {
      id: "local-1",
      idIsLocal: true,
      tags: [["msgid", "123"]],
    });
    render(<Timeline view={TEST_VIEW} />);

    fireEvent.click(chip("🔥"));
    expect(ipcMock.react).toHaveBeenCalledWith("libera", "#ctf-ops", "123", "🔥", true);
  });

  // The window between sending a line and its echo: nothing can name it yet.
  it("offers nothing on a message the server has not named", () => {
    seed([makeMessage({ id: "local-1", idIsLocal: true, text: "in flight" })]);
    useAppStore.getState().applyEvent({
      type: "capsChanged",
      network: "libera",
      enabled: ["message-tags"],
    });
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByRole("button", { name: "Add a reaction" })).toBe(null);
  });

  // A missing capability changes what the interface offers; it never produces
  // an error. The chips an archive already holds are still worth drawing.
  it("keeps the chips but drops the control on a server without message-tags", () => {
    seedReacted([{ emoji: "🔥", nicks: ["kade"] }]);
    useAppStore.getState().applyEvent({ type: "capsChanged", network: "libera", enabled: [] });
    render(<Timeline view={TEST_VIEW} />);

    expect(chip("🔥").getAttribute("aria-disabled")).toBe("true");
    expect(chip("🔥").getAttribute("aria-pressed")).toBe(null);
    fireEvent.click(chip("🔥"));
    expect(ipcMock.react).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add a reaction" })).toBe(null);
  });

  it("opens the picker onto its first choice and sends the one taken", () => {
    seedReacted([{ emoji: "🔥", nicks: ["kade"] }]);
    render(<Timeline view={TEST_VIEW} />);

    const add = screen.getByRole("button", { name: "Add a reaction" });
    fireEvent.click(add);

    const picker = screen.getByRole("group", { name: "React with" });
    const choices = within(picker).getAllByRole("button");
    expect(document.activeElement).toBe(choices[0]);

    fireEvent.click(within(picker).getByText("🎉"));
    expect(ipcMock.react).toHaveBeenCalledWith("libera", "#ctf-ops", "123", "🎉", true);
    expect(screen.queryByRole("group", { name: "React with" })).toBe(null);
    expect(document.activeElement).toBe(add);
  });

  it("closes the picker on Escape and gives the focus back", () => {
    seedReacted([{ emoji: "🔥", nicks: ["kade"] }]);
    render(<Timeline view={TEST_VIEW} />);

    const add = screen.getByRole("button", { name: "Add a reaction" });
    fireEvent.click(add);
    fireEvent.keyDown(screen.getByRole("group", { name: "React with" }), { key: "Escape" });

    expect(screen.queryByRole("group", { name: "React with" })).toBe(null);
    expect(document.activeElement).toBe(add);
    expect(ipcMock.react).not.toHaveBeenCalled();
  });
});

/**
 * #112: half of replying was built. The timeline drew "in reply to …" from a
 * `+reply` off the wire and offered no way to send one, so a user could see
 * that somebody had answered them and could not answer back.
 */
describe("staging a reply", () => {
  function seedNamed(message: Partial<ChatMessage> = {}) {
    seed([makeMessage({ id: "123", nick: "phrack", text: "the flag is in the env", ...message })]);
    useAppStore.getState().applyEvent({
      type: "capsChanged",
      network: "libera",
      enabled: ["message-tags"],
    });
  }

  function staged() {
    return useAppStore.getState().replyTo[KEY];
  }

  it("stages the msgid the server gave the message", () => {
    seedNamed();
    render(<Timeline view={TEST_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply to this message" }));
    expect(staged()).toBe("123");
  });

  it("stages the server's name for a message we sent, not the local id", () => {
    seedNamed({ id: "local-1", idIsLocal: true, tags: [["msgid", "789"]] });
    render(<Timeline view={TEST_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply to this message" }));
    expect(staged()).toBe("789");
  });

  // The same window that stops a reaction: nothing can name the message yet.
  it("offers nothing on a message the server has not named", () => {
    seedNamed({ id: "local-1", idIsLocal: true });
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByRole("button", { name: "Reply to this message" })).toBe(null);
  });

  // A reply travels as a client tag, so without message-tags there is nothing
  // to offer — and nothing to say about it, per the degradation rule.
  it("offers nothing on a server without message-tags", () => {
    seed([makeMessage({ id: "123", nick: "phrack", text: "the flag is in the env" })]);
    useAppStore.getState().applyEvent({ type: "capsChanged", network: "libera", enabled: [] });
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByRole("button", { name: "Reply to this message" })).toBe(null);
  });

  it("stays offered on a message that already has reactions", () => {
    seedNamed();
    useAppStore.getState().applyEvent({
      type: "reactionChanged",
      network: "libera",
      target: "#ctf-ops",
      message: "123",
      nick: "kade",
      emoji: "\u{1F525}",
      active: true,
    });
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByRole("button", { name: "Reply to this message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a reaction" })).toBeTruthy();
  });
});

/**
 * #138: a reply too long for the wire is split into several messages, each
 * tagged with `+reply` because each has to stand on its own for everybody else.
 * Drawing the quote under every one of them splits a paragraph in two.
 */
describe("drawing a reply quote", () => {
  function reply(id: string, over: MessageOverrides = {}) {
    return makeMessage({
      id,
      nick: "syk",
      text: `piece ${id}`,
      replyTo: "parent-1",
      ...over,
    });
  }

  function quotes() {
    return screen.queryAllByText("the flag is in the env");
  }

  function seedWithParent(replies: ChatMessage[]) {
    seed([
      makeMessage({ id: "parent-1", nick: "phrack", text: "the flag is in the env" }),
      ...replies,
    ]);
  }

  it("says once what a split reply answered", () => {
    seedWithParent([reply("a"), reply("b")]);
    render(<Timeline view={TEST_VIEW} />);

    // The parent's own line, and one quote of it.
    expect(quotes()).toHaveLength(2);
    expect(screen.getByText("piece a")).toBeTruthy();
    expect(screen.getByText("piece b")).toBeTruthy();
  });

  it("says it again when the parent changes between them", () => {
    seedWithParent([reply("a"), reply("b", { replyTo: "parent-other" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(quotes()).toHaveLength(2);
    expect(screen.getByText("in reply to parent-other")).toBeTruthy();
  });

  /** A block is a minute, not a run of one person's lines. Two people
   * answering the same message each need their own quote. */
  it("says it again for a different person answering the same message", () => {
    seedWithParent([reply("a"), reply("b", { nick: "nyx" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(quotes()).toHaveLength(3);
  });

  it("leaves a message that answers nothing alone", () => {
    seedWithParent([reply("a"), reply("b", { replyTo: null })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(quotes()).toHaveLength(2);
  });
});

/**
 * #90's second extension point. A note is what a plugin said *about* a message,
 * so what matters in the timeline is that it is drawn beside the message and
 * never reads as part of it.
 */
describe("plugin annotations", () => {
  function annotate(message: string, plugin: string, text: string) {
    useAppStore.getState().applyEvent({
      type: "messageAnnotated",
      network: "libera",
      target: "#ctf-ops",
      message,
      plugin,
      text,
    });
  }

  it("draws the note under the message, named with the plugin", () => {
    seed([makeMessage({ id: "m1", nick: "phrack", text: "it is 72F outside" })]);
    annotate("m1", "units", "22 C");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("22 C")).toBeTruthy();
    expect(screen.getByText("units")).toBeTruthy();
  });

  /** The note is not the message. A reader who cannot tell them apart is the
   * failure this whole extension point is shaped around. */
  it("keeps the note out of the message's own text", () => {
    seed([makeMessage({ id: "m1", nick: "phrack", text: "it is 72F outside" })]);
    annotate("m1", "units", "22 C");
    render(<Timeline view={TEST_VIEW} />);

    const said = screen.getByText("it is 72F outside");
    expect(said.textContent).toBe("it is 72F outside");
    expect(said.textContent).not.toContain("22 C");
  });

  it("draws a note from each plugin that had something to say", () => {
    seed([makeMessage({ id: "m1", nick: "phrack", text: "see https://example.com" })]);
    annotate("m1", "units", "22 C");
    annotate("m1", "links", "example.com — Example Domain");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("22 C")).toBeTruthy();
    expect(screen.getByText("example.com — Example Domain")).toBeTruthy();
  });

  /** One note per plugin per message: a plugin answering the same message
   * twice replaces what it said rather than saying it twice. */
  it("lets a plugin correct itself rather than repeat itself", () => {
    seed([makeMessage({ id: "m1", nick: "phrack", text: "it is 72F outside" })]);
    annotate("m1", "units", "22 C");
    annotate("m1", "units", "22.2 C");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText("22 C")).toBeNull();
    expect(screen.getByText("22.2 C")).toBeTruthy();
    expect(screen.getAllByText("units")).toHaveLength(1);
  });

  it("leaves a message nobody annotated alone", () => {
    seed([
      makeMessage({ id: "m1", nick: "phrack", text: "it is 72F outside" }),
      makeMessage({ id: "m2", nick: "sable", text: "nothing to say about this" }),
    ]);
    annotate("m1", "units", "22 C");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("units")).toHaveLength(1);
  });

  /** The annotator runs on arrival, so a note can name a message that has
   * scrolled out of the loaded window. Dropped here rather than held, because
   * the archive keeps it and hands it back with the message — which is what
   * `reactionChanged` already does for the same reason. */
  it("drops a note for a message that is not loaded", () => {
    seed([makeMessage({ id: "m1", nick: "phrack", text: "here" })]);
    annotate("gone", "units", "22 C");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText("22 C")).toBeNull();
  });

  /** The archive's copy, arriving with the message rather than as an event. */
  it("draws a note the archive handed back with the message", () => {
    seed([
      makeMessage({
        id: "m1",
        nick: "phrack",
        text: "it is 72F outside",
        annotations: [{ plugin: "units", text: "22 C" }],
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("22 C")).toBeTruthy();
    expect(screen.getByText("units")).toBeTruthy();
  });
});

/**
 * #14. A link in a message must reach the system browser and must not navigate
 * this window: the webview is the client, and a page loaded over it has no way
 * back.
 */
describe("links in a message", () => {
  const URL = "https://example.com/a";

  function withLink() {
    seed([
      makeMessage({
        id: "m1",
        nick: "phrack",
        text: `see ${URL} for it`,
        attachments: [makeAttachment({ url: URL })],
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);
    return screen.getByRole("button", { name: `${URL}, opens in your browser` });
  }

  it("opens the destination outside this window", async () => {
    const link = withLink();
    await act(async () => {
      fireEvent.click(link);
    });

    expect(openExternalMock).toHaveBeenCalledWith(URL);
  });

  /** No `href`, so there is nothing the webview could decide to navigate to —
   * not a middle click, not a dragged link, not a restored session. */
  it("offers nothing a webview could navigate to", () => {
    const link = withLink();
    expect(link.getAttribute("href")).toBeNull();
    expect(document.querySelector(`a[href="${URL}"]`)).toBeNull();
  });

  /**
   * The text used to be the destination character for character. It is the
   * host and an elided path now, which is study 07 — but the host itself is
   * never shortened, because it is the part that settles where the link goes.
   */
  it("writes the host out as the text", () => {
    expect(withLink().textContent).toContain("example.com");
  });

  /** What the elision costs is answered by the accessible name and the
   * tooltip, both of which carry the whole URL. */
  it("keeps the whole destination reachable", () => {
    const link = withLink();
    expect(link.getAttribute("aria-label")).toBe(`${URL}, opens in your browser`);
    expect(link.getAttribute("title")).toBe(URL);
  });

  /**
   * A raw string can lie about where it goes: read left to right,
   * `https://github.com@evil.com/…` is GitHub. Parsed, it is not, and the host
   * that gets drawn is the one the click would actually reach.
   */
  it("draws the host a userinfo was imitating, not the one it named", () => {
    const spoof = "https://github.com@evil.com/ergochat/ergo";
    seed([makeMessage({ id: "m2", nick: "phrack", text: `see ${spoof}`, attachments: [makeAttachment({ url: spoof })] })]);
    render(<Timeline view={TEST_VIEW} />);

    const link = screen.getByRole("button", { name: `${spoof}, opens in your browser` });
    expect(link.textContent).toContain("evil.com");
    expect(link.textContent).not.toContain("github.com");
  });

  /**
   * The reply and react controls were laid over the far end of the measure, so
   * a long link ran underneath them and the part under a control could not be
   * clicked. They have a column of their own now.
   */
  it("keeps the controls out of the text", () => {
    withLink();
    // The controls exist only where a message can be named on the wire.
    act(() => {
      useAppStore.getState().applyEvent({
        type: "capsChanged",
        network: "libera",
        enabled: ["message-tags"],
      });
    });

    const reply = screen.getByRole("button", { name: "Reply to this message" });
    const body = screen.getByRole("button", {
      name: `${URL}, opens in your browser`,
    });

    // jsdom lays nothing out, so overlap itself cannot be measured. What can
    // be checked is the structure that caused it: the controls sat inside the
    // cell holding the text, over its far end. They are a separate cell now.
    const row = body.closest("[data-msgid]");
    const cellOf = (node: Element) =>
      [...(row?.querySelector(".grid")?.children ?? [])].find((cell) =>
        cell.contains(node),
      );

    expect(cellOf(body)).toBeTruthy();
    expect(cellOf(reply)).toBeTruthy();
    expect(cellOf(body)).not.toBe(cellOf(reply));
  });

  /**
   * A `<button>` is inline-block and sizes to its content, so a long URL took
   * whatever width it wanted and ran out of the pane — over the column beside
   * it in a split, which is where it was seen.
   *
   * jsdom measures nothing, so this asks for the rules that let it wrap rather
   * than for the width it ends up at. The wrapping itself needs an eye.
   */
  it("lets a long link wrap inside the pane", () => {
    const link = withLink();
    expect(link.className).toContain("max-w-full");
    expect(link.className).toContain("break-all");
  });

  /** Said before the click rather than reported after it. A reader deciding
   * whether to follow a link is looking at it now. */
  it("marks that it leaves the client", () => {
    const link = withLink();
    // Drawn rather than written: a text arrow read as too quiet twice over.
    expect(link.querySelector("svg")).toBeTruthy();
    expect(link.getAttribute("aria-label")).toContain("opens in your browser");
  });
});
