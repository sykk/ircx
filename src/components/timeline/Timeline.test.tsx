import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, PageBackOutcome, Reaction } from "@/types";
import { TIMELINE_CAP, useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { member } from "@/components/drawer/fixtures";
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
    pageBack: vi.fn(),
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
  // the virtualiser's sizer, which does carry a real inline height, plus the
  // head above it: both are inside the scroller, so both are part of what there
  // is to scroll. Each is found by name rather than by position.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.querySelector<HTMLElement>('[data-testid="timeline-sizer"]');
      const declared = sizer?.style.height;
      if (!declared) return this.offsetHeight;
      const head = this.querySelector<HTMLElement>('[data-testid="timeline-head"]');
      return Number.parseFloat(declared) + (head?.offsetHeight ?? 0);
    },
  });
  // jsdom keeps scrollTop as a plain number and lets anything be written to it.
  // A browser will not scroll past what there is to scroll, and a pane holding
  // less than a screenful cannot be scrolled at all — which is the difference
  // between a correction that lands and one no reader ever sees.
  const offsets = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const furthest = Math.max(0, this.scrollHeight - this.clientHeight);
      offsets.set(this, Math.min(Math.max(0, value), furthest));
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
  seedTimelines({
    [KEY]: {
      messages,
      unreadFrom,
      readMarker: null,
      hasMore: true,
      loadingOlder: false,
      askedBehind: null,
    },
  });
}

/** A second pane on the same channel, as a split would open. `anchor` is the
 * row it comes back to, so a pane given one is reading history rather than
 * following; `null` follows the live edge. */
function openSecondView(anchor: string | null) {
  const id = "second-view";
  const { views, viewAnchor, viewOrder } = useAppStore.getState();
  useAppStore.setState({
    views: { ...views, [id]: { ...views[TEST_VIEW]!, id } },
    viewAnchor: { ...viewAnchor, [id]: anchor },
    viewOrder: [...viewOrder, id],
  });
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Opening a pane reads the archive, so every render below starts one. Left
  // in flight by default: a test that cares about the answer says what it is.
  ipcMock.loadHistory.mockReturnValue(new Promise(() => {}));
  // A server with nothing behind the archive, which is the answer that leaves
  // the reads below reading only what is on disk.
  ipcMock.pageBack.mockResolvedValue("end");
  ipcMock.react.mockResolvedValue({ kind: "handled" });
  useAppStore.setState({ ...oneView(null), networks: {}, timelines: {}, typing: {} });
});

describe("Timeline", () => {
  it("says so when nothing is open", () => {
    render(<Timeline view={null} />);
    expect(screen.getByText("No conversation open")).toBeTruthy();
  });

  it("heads each speaker's run with their own time", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "a", nick: "sable", text: "first", timestamp: new Date(base).toISOString() }),
      makeMessage({ id: "b", nick: "phrack", text: "second", timestamp: new Date(base + 1000).toISOString() }),
      makeMessage({ id: "c", nick: "nyx", text: "third", timestamp: new Date(base + 61_000).toISOString() }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    const clocks = document.querySelectorAll("time");
    expect(clocks).toHaveLength(3);
    expect(clocks[0]!.textContent).toBe(formatClock(new Date(base).toISOString(), "24h"));
    expect(clocks[2]!.textContent).toBe(
      formatClock(new Date(base + 61_000).toISOString(), "24h"),
    );
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("names the author once over the run, however many lines they sent", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "a", nick: "kade", text: "first", timestamp: new Date(base).toISOString() }),
      makeMessage({ id: "b", nick: "kade", text: "second", timestamp: new Date(base + 1000).toISOString() }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("kade")).toHaveLength(1);
    expect(document.querySelectorAll("time")).toHaveLength(1);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
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

  it("walks mentions in the unread messages and returns to the live edge", () => {
    const messages = makeConversation({ count: 20 }).map((message, index) =>
      index === 6 || index === 9
        ? { ...message, text: `sable: unread mention ${index}`, sender: { ...message.sender, isSelf: false } }
        : message,
    );
    seed(messages, messages[4]!.id);
    render(<Timeline view={TEST_VIEW} />);

    const controls = screen.getByLabelText("Unread messages");
    expect(within(controls).getByText("11 unread")).toBeTruthy();
    expect(within(controls).getByText("2 mentions")).toBeTruthy();

    fireEvent.keyDown(document, { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true });
    expect(document.querySelector(`[data-msgid="${messages[6]!.id}"]`)?.getAttribute("style"))
      .toContain("var(--surface-active)");

    fireEvent.keyDown(document, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(screen.queryByLabelText("Unread messages")).toBeNull();
    expect(useAppStore.getState().viewAnchor[TEST_VIEW]).toBeNull();
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

  it("shows unread catch-up events with one message of context on each side", () => {
    const messages = [
      makeMessage({
        id: "old-reaction",
        text: "old reacted line",
        reactions: [{ emoji: "eyes", nicks: ["phrack"] }],
      }),
      makeMessage({ id: "ordinary", text: "ordinary line" }),
      makeMessage({ id: "mention", nick: "phrack", text: "sable: look at this" }),
      makeMessage({ id: "after-mention", text: "message after mention" }),
      makeMessage({ id: "unrelated", text: "unrelated line" }),
      makeMessage({ id: "reply", text: "reply line", replyTo: "ordinary" }),
      makeMessage({
        id: "reaction",
        text: "reacted line",
        reactions: [{ emoji: "thumbs up", nicks: ["phrack"] }],
      }),
      makeMessage({ id: "topic", kind: "topic", text: "important topic" }),
      makeMessage({ id: "join", kind: "join", text: "routine join" }),
    ];
    seed(messages, "ordinary");
    render(<Timeline view={TEST_VIEW} catchUp />);

    expect(screen.queryByText("old reacted line")).toBeNull();
    expect(document.querySelector('[data-msgid="ordinary"]')).toBeTruthy();
    expect(document.querySelector('[data-msgid="mention"]')).toBeTruthy();
    expect(screen.getByText("message after mention")).toBeTruthy();
    expect(screen.getByText("unrelated line")).toBeTruthy();
    expect(screen.getByText("reply line")).toBeTruthy();
    expect(screen.getByText("reacted line")).toBeTruthy();
    expect(screen.getByText(/important topic/)).toBeTruthy();
    expect(ipcMock.loadHistory).not.toHaveBeenCalled();
  });

  it("has nothing to catch up on after the conversation is read", () => {
    seed([
      makeMessage({ id: "mention", nick: "phrack", text: "sable: old mention" }),
    ]);
    render(<Timeline view={TEST_VIEW} catchUp />);

    expect(screen.getByText("Nothing to catch up on")).toBeTruthy();
    expect(screen.queryByText("sable: old mention")).toBeNull();
  });

  /** A tint says the client noticed something. It does not say what, and what
   * it noticed — your name is in here — is the part a colour cannot carry. */
  it("says why a run is marked, and names who addressed you", () => {
    seed([makeMessage({ id: "a", nick: "phrack", text: "sable: look at this" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText(/addressed you by name/).textContent).toBe(
      "phrack addressed you by name",
    );
  });

  it("marks the name inside the line, so the reader is not hunting for it", () => {
    seed([makeMessage({ id: "a", nick: "phrack", text: "sable: look at this" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["sable"]);
  });

  it("says nothing about a run that does not mention you", () => {
    seed([makeMessage({ id: "a", nick: "phrack", text: "sableton is a different person" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText(/addressed you by name/)).toBeNull();
    expect(document.querySelector("mark")).toBeNull();
  });

  /** A nick inside code is a string somebody quoted. Marking it would have the
   * client claim a piece of data was about you. */
  it("leaves a nick inside code alone", () => {
    seed([makeMessage({ id: "a", nick: "phrack", text: "grep `sable` in the log" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(document.querySelector("mark")).toBeNull();
  });

  /** isHighlight already refuses your own line; the marking has to agree, or a
   * message you sent would be marked for containing your own name. */
  it("does not mark your own line back at you", () => {
    seed([
      makeMessage({
        id: "a",
        text: "sable is what they call me",
        sender: { nick: "sable", user: null, host: null, account: null, isSelf: true },
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText(/addressed you by name/)).toBeNull();
    expect(document.querySelector("mark")).toBeNull();
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

    expect(screen.getByText(/7 joined/)).toBeTruthy();
    expect(screen.queryByText("user0 joined")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: /7 joined/ }));
    expect(screen.getByText("user0 joined")).toBeTruthy();
    expect(screen.getByRole("button", { name: /7 joined/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  /** Weather is skippable exactly when none of it was about you, and a digest
   * that does not say so leaves the reader opening it to find out. */
  it("says the burst was not about you, and how long it ran", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed(
      Array.from({ length: 4 }, (_, i) =>
        makeMessage({
          id: `s${i}`,
          nick: `user${i}`,
          kind: "join",
          text: "",
          timestamp: new Date(base + i * 90_000).toISOString(),
        }),
      ),
    );
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText(/joined/).textContent).toBe(
      "Over 5 minutes: 4 joined.",
    );
  });

  it("counts your own coming and going as involving you", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({
        id: "s0",
        kind: "join",
        text: "",
        timestamp: new Date(base).toISOString(),
        sender: { nick: "sable", user: null, host: null, account: null, isSelf: true },
      }),
      makeMessage({
        id: "s1",
        nick: "kade",
        kind: "join",
        text: "",
        timestamp: new Date(base + 1000).toISOString(),
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText(/joined/).textContent).toBe("2 joined. 1 of them involves you.");
  });

  /** Modes fold now: a channel handing out ops all day used to read as one
   * where something was constantly happening, in the protocol's words. */
  it("counts a mode in the digest, in words rather than in letters", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    seed([
      makeMessage({ id: "j", nick: "kade", kind: "join", text: "", timestamp: new Date(base).toISOString() }),
      makeMessage({
        id: "m",
        nick: "ChanServ",
        kind: "mode",
        text: "took ops",
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

    // Counted with the rest, in the words core wrote rather than in `+o`.
    expect(screen.getByText(/joined/).textContent).toBe("1 joined, 1 took ops, 1 quit.");
    fireEvent.click(screen.getByRole("button", { name: /1 joined, 1 took ops, 1 quit/ }));
    // Opened, the line names who holds it — which the count cannot.
    expect(screen.getByText("ChanServ took ops")).toBeTruthy();
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
    expect(screen.getByText("in reply to an earlier message")).toBeTruthy();
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
    // A pane holding less than a screenful primes itself with a read, so the
    // head is already up and the anchor has already paid for it (#475). Nothing
    // has scrolled: this is the whole of the distance, and the append below is
    // measured from it.
    expect(scroller.scrollTop).toBe(HEAD_PX);

    act(() => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        answers: null,
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
        unreadFrom: null, readMarker: null,
        hasMore: false,
        loadingOlder: false, askedBehind: null
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

  /**
   * #331. A pane with nothing to scroll never fires the handler that asks for
   * more, so opening one primes it with a page. One page is not always a
   * screenful: a run of presence folds into a single digest row, and 200 more
   * quits can add no height at all. A channel whose archive is a netsplit
   * stopped there with the rest of it out of reach.
   */
  describe("a channel whose history folds away to nothing", () => {
    /** All inside one `RUN_MS`, so however many are read they draw as one row. */
    const quits = (from: number, count: number) => {
      const base = Date.parse("2026-07-29T02:00:00.000Z");
      return Array.from({ length: count }, (_, i) =>
        makeMessage({
          id: `q${from + i}`,
          nick: `crowd${from + i}`,
          kind: "quit",
          text: "*.net *.split",
          timestamp: new Date(base + (from + i) * 50).toISOString(),
        }),
      );
    };

    it("keeps reading until it reaches the beginning of the archive", async () => {
      // Three pages and a short one, which is what the archive running out
      // looks like from here.
      const pages = [quits(600, 200), quits(400, 200), quits(200, 200), quits(0, 60)];
      let asked = 0;
      ipcMock.loadHistory.mockImplementation(() =>
        Promise.resolve(pages[asked++] ?? []),
      );

      seed([]);
      render(<Timeline view={TEST_VIEW} />);

      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(660),
      );
      expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(false);
    });

    /**
     * Under `StrictMode` the effect is mounted twice, so the second run asks
     * again before the first read has told the store it is running — and that
     * call comes straight back having done nothing. Reading that as "the
     * archive has no more to give" stops the loop after one page, which is the
     * shape of the first attempt at fixing this. A scroll landing during a read
     * does the same thing without `StrictMode`.
     */
    it("keeps reading when a second ask overlaps the first", async () => {
      const pages = [quits(400, 200), quits(200, 200), quits(0, 60)];
      let asked = 0;
      // A read that takes longer than a turned-away one, which is the whole
      // point: resolving both in the same microtask lets the real answer land
      // first and the overlap never shows.
      ipcMock.loadHistory.mockImplementation(() => {
        const page = pages[asked++] ?? [];
        return new Promise((resolve) => setTimeout(() => resolve(page), 5));
      });

      seed([]);
      render(
        <StrictMode>
          <Timeline view={TEST_VIEW} />
        </StrictMode>,
      );

      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(false),
      );
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(460);
    });

    it("reads nothing ahead when the pane can already be scrolled", async () => {
      // Ordinary conversation, which does not fold. The reader can reach the
      // top on their own, and reaching it is what asks for the next page — so
      // opening this should cost no read at all.
      ipcMock.loadHistory.mockResolvedValue([]);

      seed(makeConversation({ count: 400, seed: 3 }));
      render(<Timeline view={TEST_VIEW} />);

      // Long enough for a page to have been asked for, had it been.
      await act(() => new Promise((done) => setTimeout(done, 50)));
      expect(ipcMock.loadHistory).not.toHaveBeenCalled();
    });
  });

  /**
   * #472. The archive running out is not the history running out. What is behind
   * it is on the server, and the pane used to say "Beginning of history" over a
   * server still holding it.
   */
  describe("reaching past the archive", () => {
    const older = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeMessage({
          id: `old-${i}`,
          nick: "phrack",
          text: `older ${i}`,
          timestamp: new Date(Date.parse("2026-07-28T00:00:00.000Z") + i * 30_000).toISOString(),
        }),
      );

    /** A conversation with a page and a bit on disk, scrolled to the top of it. */
    const readToTheStart = async (page: ChatMessage[]) => {
      ipcMock.loadHistory.mockResolvedValue(page);
      seed(makeConversation({ count: 400, seed: 3 }));
      render(<Timeline view={TEST_VIEW} />);

      const scroller = screen.getByTestId("timeline-scroller");
      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalled());
    };

    it("asks the server for what is behind a short page, from the oldest message it holds", async () => {
      const page = older(60);
      await readToTheStart(page);

      await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      expect(ipcMock.pageBack).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        page[0]!.timestamp,
        page[0]!.id,
        page[0]!.id,
      );
    });

    /** #496, the other half of #494. A pane opening on an empty timeline has no
     * message to ask the archive from, so it asks with `before` null — which
     * `load_history` answers with the newest page it holds rather than with a
     * page behind anything. The read is awaited, and the server's own
     * `CHATHISTORY LATEST` lands while it is in flight. `older[0]` then names
     * a row from today, and asking the server for what is behind *that* asks
     * again for the page it has already sent. */
    it("asks from the oldest message the window will hold, not the page's own first row", async () => {
      // Answered rather than ended, because the guard below is armed only where
      // there is a later scroll for it to refuse.
      ipcMock.pageBack.mockResolvedValue("more");
      let answer: (page: ChatMessage[]) => void = () => {};
      ipcMock.loadHistory.mockReturnValue(
        new Promise<ChatMessage[]>((resolve) => {
          answer = resolve;
        }),
      );

      seed([]);
      render(<Timeline view={TEST_VIEW} />);
      await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalled());
      // Asked with nothing to ask from, which is the whole of the case.
      expect(ipcMock.loadHistory).toHaveBeenCalledWith(
        expect.objectContaining({ before: null }),
      );

      // The server's page, landing while the archive is still being read.
      const history = older(3);
      act(() => {
        useAppStore.getState().applyEvent({
          type: "messagesAppended",
          answers: null,
          network: "libera",
          target: "#ctf-ops",
          messages: history,
        });
      });

      // The archive's newest page: today's rows, which are not behind anything.
      const today = makeMessage({
        id: "joined",
        text: "sable joined",
        timestamp: "2026-08-12T12:06:19.829Z",
      });
      await act(async () => {
        answer([today]);
      });

      await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      expect(ipcMock.pageBack).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        history[0]!.timestamp,
        history[0]!.id,
        history[0]!.id,
      );
      expect(useAppStore.getState().timelines[KEY]!.askedBehind).toBe(history[0]!.id);
    });

    /**
     * The same read, on the archive a first launch has: empty. `older` comes
     * back with nothing and the snapshot taken before the await held nothing
     * either, so the only message this conversation has ever seen is the one
     * the server delivered *while the read was in flight*.
     *
     * Taking the oldest from the snapshot answers `undefined` there, and
     * `pageBack` reads that as a conversation with nothing behind it — `"end"`,
     * `hasMore` false, "Beginning of history" drawn over a server holding
     * thousands. A pane that opens on a fresh profile and loses this race can
     * never be scrolled into its own history for the rest of the run.
     *
     * Reading the head after the await is what sees the page that landed.
     */
    it("asks from the page that landed while the empty archive was being read", async () => {
      let answer: (page: ChatMessage[]) => void = () => {};
      ipcMock.loadHistory.mockReturnValue(
        new Promise<ChatMessage[]>((resolve) => {
          answer = resolve;
        }),
      );
      // A server that does hold more, so that what the pane decides about its
      // own history is the pane's decision rather than the server's answer.
      ipcMock.pageBack.mockResolvedValue("more");

      seed([]);
      render(<Timeline view={TEST_VIEW} />);
      await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalled());

      // The server's own page, landing while the archive read is in flight.
      const history = older(3);
      act(() => {
        useAppStore.getState().applyEvent({
          type: "messagesAppended",
          answers: null,
          network: "libera",
          target: "#ctf-ops",
          messages: history,
        });
      });

      // The archive had nothing to give: a first launch has written none of
      // this down yet.
      await act(async () => {
        answer([]);
      });

      await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      expect(ipcMock.pageBack).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        history[0]!.timestamp,
        history[0]!.id,
        history[0]!.id,
      );
      // The history did not end here, and the pane may still be read back.
      expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
      expect(screen.queryByText("Beginning of history")).toBeNull();
    });

    it("leaves the server alone while the archive still has a full page to give", async () => {
      await readToTheStart(older(200));

      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
      );
      expect(ipcMock.pageBack).not.toHaveBeenCalled();
      expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
    });

    it("keeps paging while the server says there is more behind it", async () => {
      ipcMock.pageBack.mockResolvedValue("more");
      await readToTheStart(older(60));

      await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
    });

    it("is the beginning of history once the server has none either", async () => {
      await readToTheStart(older(60));

      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(false),
      );
      expect(screen.getByText("Beginning of history")).toBeTruthy();
    });

    /**
     * #487. A page asked of the server does not arrive down the call that asked
     * for it: the request goes out and the messages come back as their own
     * event. So the oldest message a pane holds is still the one it just asked
     * about, and every scroll event of the same wheel burst computed the very
     * same request — the same msgid 40ms behind the first, and the release
     * build sent every one of them.
     */
    describe("while the page it asked for is still coming", () => {
      const scrollAgain = async () => {
        const scroller = screen.getByTestId("timeline-scroller");
        scroller.scrollTop = 80;
        fireEvent.scroll(scroller);
        // Long enough for a second read to have gone out, had it been asked for.
        await act(() => new Promise((done) => setTimeout(done, 50)));
      };

      /** The page, arriving the way the server's history does: in front of the
       * oldest message the pane holds, naming the ask it answers. */
      const land = (before: ChatMessage, answers: string | null = null, count = 200) => {
        const messages = Array.from({ length: count }, (_, i) =>
          makeMessage({
            id: `landed-${i}`,
            nick: "phrack",
            text: `landed ${i}`,
            timestamp: new Date(
              Date.parse(before.timestamp) - (count - i) * 30_000,
            ).toISOString(),
          }),
        );
        act(() => {
          useAppStore
            .getState()
            .applyEvents([
              { type: "messagesAppended", answers, network: "libera", target: "#ctf-ops", messages },
            ]);
        });
        return messages;
      };

      it("asks for it once, however many scroll events reach the top", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        await readToTheStart(older(60));
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        await scrollAgain();
        await scrollAgain();

        expect(ipcMock.pageBack).toHaveBeenCalledTimes(1);
        expect(ipcMock.loadHistory).toHaveBeenCalledTimes(1);
      });

      /** There may be more behind a page already on its way, which is what the
       * reader is told rather than that this is where history stops. */
      it("does not read as the beginning of history", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        await readToTheStart(older(60));
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        await scrollAgain();

        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
        expect(screen.queryByText("Beginning of history")).toBeNull();
      });

      /**
       * The answer to a page-back cannot be recognised from here, which is what
       * ruled out holding the pane loading until one arrived. #486 is a channel
       * opening by asking for the page `CHATHISTORY LATEST` is already
       * delivering: that batch lands carrying nothing the pane does not hold,
       * so a pane waiting to see messages arrive would wait for the rest of the
       * run. It waits on its own oldest message instead, and that one moved.
       */
      it("keeps paging when the answer carried nothing new", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        const page = older(60);
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        // The same messages again, which is what a duplicated page is.
        act(() => {
          useAppStore
            .getState()
            .applyEvents([
              { type: "messagesAppended", answers: null, network: "libera", target: "#ctf-ops", messages: page },
            ]);
        });
        const landed = land(page[0]!);
        ipcMock.loadHistory.mockResolvedValue([]);
        await scrollAgain();

        expect(ipcMock.pageBack).toHaveBeenLastCalledWith(
          "libera",
          "#ctf-ops",
          landed[0]!.timestamp,
          landed[0]!.id,
          landed[0]!.id,
        );
      });

      /**
       * And when nothing lands behind it either. #522.
       *
       * The batch is the whole of what that ask was answered with, and it moved
       * the pane's oldest message not at all. The guard used to be armed on
       * that message and to come off by its moving, so it stayed on: every
       * later scroll refused for a page that had already arrived, nothing short
       * of a reconnect clearing it, and the reader left at the top of a
       * conversation that says it has more and cannot be made to go and look.
       *
       * Asking again is the wrong repair and the walk in `docs/end-to-end-27`
       * is why — the same msgid went out 26 times in a walk, 65ms apart, which
       * is #487 again. The server answered. What it answered with is that there
       * is nothing behind this message, whatever the page's size said about
       * fullness, so the paging stops and the pane says where the history ends.
       */
      it("stops paging when the page that answered it moved nothing", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        const page = older(60);
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        // The batch that ask was answered with, arriving off the server the way
        // the answer says it already has, naming the ask it belongs to and
        // carrying nothing the pane's own archive read had not given it.
        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: page[0]!.id,
              network: "libera",
              target: "#ctf-ops",
              messages: page.map((m) => ({ ...m, source: "serverHistory" as const })),
            },
          ]);
        });
        ipcMock.loadHistory.mockResolvedValue([]);

        await scrollAgain();
        await scrollAgain();

        expect(ipcMock.pageBack).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(false);
        expect(await screen.findByText("Beginning of history")).toBeTruthy();
      });

      /**
       * And the reader is not told that where a page is still coming. The same
       * batch, landing before the answer to the ask it belongs to — which is
       * the ordinary order, core emitting the messages before the outcome — is
       * read the same way round: the guard is armed before the ask goes out, so
       * the batch that names it finds it armed whichever channel arrives first.
       */
      it("stops paging when that page landed before the answer did", async () => {
        const page = older(60);
        let answer: (outcome: PageBackOutcome) => void = () => {};
        ipcMock.pageBack.mockReturnValue(
          new Promise<PageBackOutcome>((resolve) => {
            answer = resolve;
          }),
        );
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: page[0]!.id,
              network: "libera",
              target: "#ctf-ops",
              messages: page.map((m) => ({ ...m, source: "serverHistory" as const })),
            },
          ]);
        });
        await act(async () => {
          answer("more");
        });

        await waitFor(() =>
          expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(false),
        );
      });

      /**
       * `deferred` is the other half of the same distinction. Nothing went out:
       * the conversation's own first page was already coming and is what
       * answered, and it says nothing about what is behind the window. So a
       * batch carrying nothing new does not end the paging there — the question
       * has not been asked yet — and the reader can still ask it.
       */
      it("keeps paging when no ask went out and the first page carried nothing new", async () => {
        ipcMock.pageBack.mockResolvedValue("deferred");
        const page = older(60);
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: null,
              network: "libera",
              target: "#ctf-ops",
              messages: page.map((m) => ({ ...m, source: "serverHistory" as const })),
            },
          ]);
        });
        ipcMock.loadHistory.mockResolvedValue([]);

        await scrollAgain();

        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
        expect(ipcMock.pageBack).toHaveBeenCalledTimes(2);
      });

      it("asks for the next one once it has landed", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        const page = older(60);
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        const landed = land(page[0]!);
        // The archive is behind the pane once a page has landed in front of it:
        // what came off the server is already held, and there is nothing on
        // disk older than it. Every landing in the walk that found #487 read
        // exactly this.
        ipcMock.loadHistory.mockResolvedValue([]);
        await scrollAgain();

        expect(ipcMock.pageBack).toHaveBeenCalledTimes(2);
        expect(ipcMock.pageBack).toHaveBeenLastCalledWith(
          "libera",
          "#ctf-ops",
          landed[0]!.timestamp,
          landed[0]!.id,
          landed[0]!.id,
        );
      });

      /**
       * #540. The round trip's deadline is 60s and the answer outlives it —
       * `answered_in_time` reads passing it as "nothing failed, the answer may
       * still arrive" — so a reader who gave up and asked again has two
       * page-backs outstanding and is sent both answers. The late one carries
       * the page its replacement already delivered, and lands against the guard
       * armed for the question after that.
       *
       * Read as the answer to that question, it said the server had nothing
       * behind a message it was never asked about: "Beginning of history" over
       * a conversation whose next page was in flight, and every later scroll
       * refused for the rest of the run.
       */
      it("keeps paging when what lands answers an ask two questions old", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        const page = older(60);
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        // The answer to that ask, and the reader scrolls on behind it.
        const landed = land(page[0]!, page[0]!.id);
        ipcMock.loadHistory.mockResolvedValue([]);
        await scrollAgain();
        await waitFor(() =>
          expect(useAppStore.getState().timelines[KEY]!.askedBehind).toBe(landed[0]!.id),
        );

        // The page the pane gave up on, arriving at last: every row of it is
        // held, and it names the ask it was made for rather than this one.
        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: page[0]!.id,
              network: "libera",
              target: "#ctf-ops",
              messages: landed.map((m) => ({ ...m, source: "serverHistory" as const })),
            },
          ]);
        });

        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
        expect(screen.queryByText("Beginning of history")).toBeNull();
        expect(useAppStore.getState().timelines[KEY]!.askedBehind).toBe(landed[0]!.id);
      });

      /** A channel does not go quiet because somebody is paging through it, and
       * a line arriving at the live edge is not the page they are waiting for. */
      it("is not satisfied by a message arriving at the other end", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        await readToTheStart(older(60));
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: null,
              network: "libera",
              target: "#ctf-ops",
              messages: [makeMessage({ id: "live", timestamp: "2026-08-01T00:00:00.000Z" })],
            },
          ]);
        });

        await scrollAgain();
        expect(ipcMock.pageBack).toHaveBeenCalledTimes(1);
      });

      /** The session abandons its page-backs when the connection goes, so a
       * pane still waiting for one would wait for the rest of the run. */
      it("stops waiting when the connection does", async () => {
        ipcMock.pageBack.mockResolvedValue("more");
        await readToTheStart(older(60));
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(1));

        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "connectionChanged",
              network: "libera",
              status: { state: "reconnecting", detail: { inSeconds: 5 } },
            },
          ]);
        });

        await scrollAgain();
        expect(ipcMock.pageBack).toHaveBeenCalledTimes(2);
      });
    });

    /**
     * #491. A page slower than the deadline on the ask used to be reported as
     * the network having stopped responding, in the danger colour, advising a
     * reconnect — and then the page arrived and drew correctly underneath it.
     * The run that found it took the page 45 seconds later.
     */
    describe("when the server has not answered yet", () => {
      const waited = async () => {
        ipcMock.pageBack.mockResolvedValue("waiting");
        await readToTheStart(older(60));
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      };

      /** Back to the top, and long enough after for a read to have gone out
       * had one been asked for. */
      const scrollTo = async (top: number) => {
        const scroller = screen.getByTestId("timeline-scroller");
        scroller.scrollTop = top;
        fireEvent.scroll(scroller);
        await act(() => new Promise((done) => setTimeout(done, 50)));
      };

      it("says so, without calling it a failure", async () => {
        await waited();

        const head = await screen.findByTestId("timeline-head");
        expect(head.textContent).toBe("The server has not sent this page yet");
        expect(head.style.color).toBe("var(--text-faint)");
      });

      /** The history has not been said to end here, so the pane is still owed
       * a page and may still ask for what is behind it. */
      it("is not the beginning of history", async () => {
        await waited();

        expect(useAppStore.getState().timelines[KEY]!.hasMore).toBe(true);
        expect(screen.queryByText("Beginning of history")).toBeNull();
      });

      it("takes the line back off when the page arrives", async () => {
        const page = older(60);
        ipcMock.pageBack.mockResolvedValue("waiting");
        await readToTheStart(page);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());

        act(() => {
          useAppStore.getState().applyEvents([
            {
              type: "messagesAppended",
              answers: null,
              network: "libera",
              target: "#ctf-ops",
              messages: [
                makeMessage({
                  id: "landed",
                  nick: "phrack",
                  text: "landed",
                  timestamp: new Date(Date.parse(page[0]!.timestamp) - 30_000).toISOString(),
                }),
              ],
            },
          ]);
        });

        await waitFor(() =>
          expect(screen.queryByText("The server has not sent this page yet")).toBeNull(),
        );
      });

      /**
       * The page that never lands. A batch the server answers empty — or one
       * carrying only what the pane already holds — moves nothing, so the
       * oldest message is still the one the #487 guard was armed with, and
       * every later scroll is refused for a page that is no longer coming.
       * Nothing but a reconnect clears `askedBehind`, which left the reader
       * scrolling at the top of a conversation that says it has more and
       * cannot be made to go and look.
       *
       * The outcome is what settles it: `waiting` is returned when the round
       * trip has *already* been spent, so the ask the guard names has outlived
       * its own deadline by the time the answer gets here. Asking once more
       * after a minute of silence is a retry, not the burst #487 was.
       */
      it("asks again for a page whose round trip has already been spent", async () => {
        await waited();
        expect(ipcMock.pageBack).toHaveBeenCalledTimes(1);

        await scrollTo(80);

        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(2));
      });

      /** Which is not a licence to ask once per scroll event. The retry holds
       * `loadingOlder` for as long as its own round trip, and that is the
       * guard a burst meets. */
      it("holds the retry to one ask, however many scroll events reach the top", async () => {
        await waited();
        ipcMock.pageBack.mockReturnValue(new Promise(() => {}));

        await scrollTo(80);
        await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalledTimes(2));
        await scrollTo(60);
        await scrollTo(40);

        expect(ipcMock.pageBack).toHaveBeenCalledTimes(2);
      });
    });

    /** A locally minted id names nothing a server can resolve, so only the
     * timestamp goes with it. */
    it("sends no msgid for a message this client named itself", async () => {
      const page = older(60).map((message, i) =>
        i === 0 ? { ...message, idIsLocal: true } : message,
      );
      await readToTheStart(page);

      await waitFor(() => expect(ipcMock.pageBack).toHaveBeenCalled());
      expect(ipcMock.pageBack).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        page[0]!.timestamp,
        null,
        page[0]!.id,
      );
    });
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

  /**
   * Every walk behind #475 and #477 pages history in above the reader. A
   * message arriving live is the other direction, and the anchor has no term
   * for it: `isPrepend` is false on an append, so nothing puts the pane back.
   * What holds the reader still is that the growth is below them — which is
   * true of an append and is not true of every arrival.
   */
  describe("a message arriving while the reader is scrolled back", () => {
    const base = Date.parse("2026-07-29T02:00:00.000Z");
    const stamp = (ms: number) => new Date(base + ms).toISOString();
    /** Wider than `RUN_MS`, so every message is a row of its own and the offset
     * a message is drawn at is the offset its row is drawn at. */
    const GAP_MS = 6 * 60 * 1000;
    const line = (id: string, at: number) =>
      makeMessage({ id, nick: "sable", text: `line ${id}`, timestamp: stamp(at) });

    /** How far below the top of the viewport a message is drawn. Rows are laid
     * out inside the sizer, which starts below the head, so the head has to be
     * added back before `scrollTop` can be taken off. */
    function eyeLine(scroller: HTMLElement, msgid: string): number {
      const row = document
        .querySelector(`[data-msgid="${msgid}"]`)
        ?.closest<HTMLElement>("[data-index]");
      if (!row) throw new Error(`${msgid} is not rendered`);
      const head = scroller.querySelector<HTMLElement>('[data-testid="timeline-head"]');
      const top = Number.parseFloat(row.style.transform.replace(/[^-\d.]/g, ""));
      return top + (head?.offsetHeight ?? 0) - scroller.scrollTop;
    }

    /** A pane the reader has scrolled back in, far enough from the top that the
     * scroll does not also ask for a page of history. */
    function readBack(messages: ChatMessage[], to: number) {
      seed(messages);
      render(<Timeline view={TEST_VIEW} />);
      const scroller = screen.getByTestId("timeline-scroller");
      scroller.scrollTop = to;
      fireEvent.scroll(scroller);
      return scroller;
    }

    const arrive = (messages: ChatMessage[]) =>
      act(() => {
        useAppStore
          .getState()
          .applyEvent({ type: "messagesAppended", answers: null, network: "libera", target: "#ctf-ops", messages });
      });

    it("leaves the reader where they were when it lands below them", () => {
      const scroller = readBack(
        Array.from({ length: 400 }, (_, i) => line(`m${i}`, i * GAP_MS)),
        5_000,
      );
      const before = eyeLine(scroller, "m110");

      arrive([line("live", 400 * GAP_MS)]);

      expect(eyeLine(scroller, "m110")).toBe(before);
    });

    it("leaves the reader where they were when it sorts in above them", () => {
      // `mergeByTime`: a server that stamps a message behind what is already
      // held puts it at its own time rather than at the bottom. The reader is
      // below the insertion point, so everything under their eyes moves.
      const scroller = readBack(
        Array.from({ length: 400 }, (_, i) => line(`m${i}`, i * GAP_MS)),
        5_000,
      );
      const before = eyeLine(scroller, "m110");

      arrive([
        makeMessage({
          id: "late",
          nick: "phrack",
          text: "late line",
          timestamp: stamp(20 * GAP_MS + 60_000),
        }),
      ]);

      expect(eyeLine(scroller, "m110")).toBe(before);
    });

    it("leaves the reader where they were when the window drops its oldest", () => {
      // A pane already holding `TIMELINE_CAP` loses a message off the front for
      // every one that arrives, which takes a row out from above the reader.
      const scroller = readBack(
        Array.from({ length: TIMELINE_CAP }, (_, i) => line(`m${i}`, i * GAP_MS)),
        5_000,
      );
      const before = eyeLine(scroller, "m110");

      arrive([line("live", TIMELINE_CAP * GAP_MS)]);

      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(TIMELINE_CAP);
      expect(eyeLine(scroller, "m110")).toBe(before);
    });
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
    const second = openSecondView(null);
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );

    const [reading, other] = screen.getAllByTestId("timeline-scroller");
    // Parked by scrolling rather than by seeding a position: the store holds the
    // row a pane is reading, and only a scroll knows which row that is. Far
    // enough down that this pane does not ask for history itself.
    other!.scrollTop = 900;
    fireEvent.scroll(other!);

    const heightBefore = reading!.scrollHeight;
    reading!.scrollTop = 100;
    fireEvent.scroll(reading!);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );

    const grew = reading!.scrollHeight - heightBefore;
    expect(grew).toBeGreaterThan(0);
    expect(reading!.scrollTop).toBe(100 + grew);
    expect(other!.scrollTop).toBe(900 + grew);
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

  /** #300. Splitting a pane rebuilds it, so what the store holds is all it
   * comes back to. A pane at the live edge that recorded an offset came back to
   * wherever that offset fell at the narrower width, which was the top. */
  it("records a pane at the live edge as following rather than as a row", () => {
    seed(makeConversation({ count: 400, seed: 7 }));
    render(<Timeline view={TEST_VIEW} />);

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = scroller.scrollHeight - VIEWPORT_PX;
    fireEvent.scroll(scroller);

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(useAppStore.getState().viewAnchor[TEST_VIEW]).toBe(null);
  });

  /** #307. The row rather than the offset, because the pane is rebuilt at a
   * width where the same offset is a different message. */
  it("records the row at the top of a pane reading history", () => {
    seed(makeConversation({ count: 400, seed: 7 }));
    render(<Timeline view={TEST_VIEW} />);

    const scroller = screen.getByTestId("timeline-scroller");
    const anchorAt = (offset: number) => {
      scroller.scrollTop = offset;
      fireEvent.scroll(scroller);
      return useAppStore.getState().viewAnchor[TEST_VIEW];
    };

    const deep = anchorAt(4_000);
    const shallow = anchorAt(1_000);

    expect(deep).toBeTruthy();
    expect(shallow).toBeTruthy();
    expect(deep).not.toBe(shallow);
  });

  it("offers a direct return to the live edge while reading history", () => {
    seed(makeConversation({ count: 400, seed: 7 }));
    render(<Timeline view={TEST_VIEW} />);

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = 4_000;
    fireEvent.scroll(scroller);

    const button = screen.getByRole("button", { name: "Jump to latest" });
    letItScroll(scroller);
    fireEvent.click(button);

    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    expect(useAppStore.getState().viewAnchor[TEST_VIEW]).toBe(null);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - VIEWPORT_PX);
  });

  it("comes back to the row it recorded rather than to the top", () => {
    seed(makeConversation({ count: 400, seed: 7 }));
    const { unmount } = render(<Timeline view={TEST_VIEW} />);

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = 4_000;
    fireEvent.scroll(scroller);
    const anchor = useAppStore.getState().viewAnchor[TEST_VIEW];
    expect(anchor).toBeTruthy();

    unmount();
    // The restore goes through the virtualiser, which scrolls by `scrollTo`, and
    // it runs in a layout effect on the first render — so the shim has to be in
    // place before the render, and cannot be hung on the element afterwards the
    // way `letItScroll` does it. Put back straight away: left on the prototype
    // it would also let the prepend compensation run in every test below.
    const withoutScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    } as HTMLElement["scrollTo"];
    try {
      render(<Timeline view={TEST_VIEW} />);
    } finally {
      HTMLElement.prototype.scrollTo = withoutScrollTo;
    }

    expect(useAppStore.getState().viewAnchor[TEST_VIEW]).toBe(anchor);
    expect(screen.getByTestId("timeline-scroller").scrollTop).toBeGreaterThan(3_000);
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

    // The token rather than a fraction: what the row is dimmed by is the
    // theme's to say, and the value it resolves to is asserted against the AA
    // floor in src/styles/tokens.test.ts.
    expect((document.querySelector('[data-msgid="a"]') as HTMLElement).style.opacity).toBe(
      "var(--pending-opacity)",
    );
    expect(screen.getByText("Not sent — Cannot send to channel")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  /** The fade is the only mark a queued line carries, and #339 is that it is
   * the only one. A failed line has said so in words all along, one row down
   * from this one. */
  it("says in words that a queued line has not left, and only of the queued one", () => {
    seed([
      makeMessage({ id: "a", text: "in flight", delivery: { state: "pending" } }),
      makeMessage({ id: "b", text: "arrived", delivery: { state: "delivered" } }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("Waiting to send")).toHaveLength(1);
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
    expect(screen.getByText("in reply to an earlier message")).toBeTruthy();
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

  /** A reply names its parent the way the server does. Our own lines keep the
   * local id they were drawn with, so quoting one means resolving its `msgid`
   * tag — otherwise answering yourself quoted a message that was on the screen
   * as one the window does not hold. */
  it("quotes a message we sent, named by the msgid its echo carried", () => {
    seed([
      makeMessage({
        id: "local-1",
        idIsLocal: true,
        tags: [["msgid", "789"]],
        nick: "syk",
        text: "the flag is in the env",
      }),
      reply("a", { replyTo: "789" }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(quotes()).toHaveLength(2);
    expect(screen.queryByText("in reply to an earlier message")).toBe(null);
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

/**
 * #90's third extension point, drawn. A rule shows nothing of its own — what a
 * reader sees is a conversation gone loud, so what the timeline has to say is
 * why, and which rule thought so.
 */
describe("a message a notification rule raised", () => {
  function raise(message: string, plugin: string) {
    useAppStore.getState().applyEvent({
      type: "messageRaised",
      network: "libera",
      target: "#ctf-ops",
      message,
      plugin,
    });
  }

  it("says which rule raised it, under the message", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "deploy failed on main" })]);
    raise("m1", "deploys");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("raised by")).toBeTruthy();
    expect(screen.getByText("deploys")).toBeTruthy();
  });

  /** The whole point of naming it: without this the badge is a channel marked
   * as loudly as a mention, with nothing in it that mentions the reader. */
  it("marks the run as loudly as a mention does", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "deploy failed on main" })]);
    raise("m1", "deploys");
    render(<Timeline view={TEST_VIEW} />);

    expect(accentSpines()).toBe(1);
  });

  it("leaves the spine alone for a run nothing raised", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "starting a build" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(accentSpines()).toBe(0);
  });

  /** The mark alone was not enough to see: faint text under the message read as
   * trailing debris. The row is tinted as a mention's row is, so the line that
   * caused the noise is the line that looks different. */
  it("tints the raised row, and only the raised row", () => {
    seed([
      makeMessage({ id: "m1", nick: "buildbot", text: "starting a build" }),
      makeMessage({ id: "m2", nick: "buildbot", text: "deploy failed on main" }),
    ]);
    raise("m2", "deploys");
    render(<Timeline view={TEST_VIEW} />);

    expect(tintedRows()).toEqual(["deploy failed on main"]);
  });

  /** Every row a mention tints, and no others. */
  function tintedRows() {
    return [...document.querySelectorAll("div")]
      .filter((row) => (row.getAttribute("style") ?? "").includes("var(--mention-bg)"))
      .map((row) => row.textContent?.replace("raised by deploys", "").trim());
  }

  /** The spine is the block's, drawn as one element with no text of its own. */
  function accentSpines() {
    return [...document.querySelectorAll('[aria-hidden="true"]')].filter((spine) =>
      (spine.getAttribute("style") ?? "").includes("var(--accent)"),
    ).length;
  }

  it("names both when two rules raised the same message", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "deploy failed on main" })]);
    raise("m1", "deploys");
    raise("m1", "oncall");
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("deploys, oncall")).toBeTruthy();
  });

  /** A rule's mark is the client speaking about a plugin; a note is the
   * plugin's own words. They stack on one message and must stay legible as
   * two different things. */
  it("keeps the mark and a note apart on the same message", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "deploy failed at 72F" })]);
    raise("m1", "deploys");
    useAppStore.getState().applyEvent({
      type: "messageAnnotated",
      network: "libera",
      target: "#ctf-ops",
      message: "m1",
      plugin: "units",
      text: "22 C",
    });
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("raised by")).toBeTruthy();
    expect(screen.getByText("22 C")).toBeTruthy();
  });

  it("leaves a message nothing raised unmarked", () => {
    seed([makeMessage({ id: "m1", nick: "buildbot", text: "starting a build" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText("raised by")).toBeNull();
  });
});

/**
 * #221 and #222, both found by the third end-to-end run. Ergo replays a
 * channel's comings and goings inside the history batch as ordinary messages
 * from `HistServ`, and one of them says the reader's own name.
 */
describe("a conversation the server replayed", () => {
  const narration = () =>
    makeMessage({
      id: "h",
      nick: "HistServ",
      text: "sable joined the channel",
      source: "serverHistory",
    });

  function seedWithRoster(messages: ChatMessage[], nicks: string[]) {
    seed(messages);
    useAppStore.setState({ members: { [KEY]: nicks.map((nick) => member(nick)) } });
  }

  it("says where the replay starts and where it gives way", () => {
    seedWithRoster(
      [
        makeMessage({ id: "a", nick: "phrack", text: "away for a bit", source: "serverHistory" }),
        makeMessage({ id: "b", nick: "phrack", text: "back now" }),
      ],
      ["phrack", "sable"],
    );
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("From the server's history")).toBeTruthy();
    expect(screen.getByText("Live from here")).toBeTruthy();
  });

  it("does not let a service in the replay claim it addressed you", () => {
    seedWithRoster([narration()], ["phrack", "sable"]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.queryByText(/addressed you by name/)).toBeNull();
    expect(document.querySelector('[data-msgid="h"]')?.getAttribute("data-highlight")).toBe(null);
  });

  /** The gate is about who is in the conversation, not about where the message
   * came from: somebody who really did call your name while you were away is
   * the thing a backfill is worth reading for. */
  it("still marks a person in the channel who named you while you were away", () => {
    seedWithRoster(
      [
        makeMessage({
          id: "a",
          nick: "phrack",
          text: "sable: the build is broken",
          source: "serverHistory",
        }),
      ],
      ["phrack", "sable"],
    );
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText(/addressed you by name/).textContent).toBe(
      "phrack addressed you by name",
    );
  });

  /** Before the names arrive there is nothing to check against, and silencing
   * every mention until they do would lose the ones that matter most. */
  it("marks a mention while the roster is still empty", () => {
    seed([makeMessage({ id: "a", nick: "phrack", text: "sable: look at this" })]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText(/addressed you by name/)).toBeTruthy();
  });
});

/** #341: a cut mid-paste fails every queued line at once, and a notice under
 * each of them said one fact about the connection as many times as there were
 * lines. Walked at 78. */
describe("a run of lines that failed together", () => {
  function stranded(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeMessage({
        id: `s${i}`,
        nick: "walker",
        text: `paste line ${i + 1}`,
        delivery: { state: "failed", detail: "not connected to Queue" },
      }),
    );
  }

  it("says it once for the run, not once for each line", () => {
    seed(stranded(78));
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("78 messages were not sent — not connected to Queue")).toHaveLength(
      1,
    );
    expect(screen.queryByText("Not sent — not connected to Queue")).toBeNull();
    expect(screen.getAllByText("Retry")).toHaveLength(1);
  });

  /** The reserved column the reply controls would have used, which a failed
   * message never has one for. Every line of the run still says it did not go;
   * only the reason and the way back are said once. */
  it("still marks every line of the run", () => {
    seed(stranded(78));
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getAllByText("Not sent")).toHaveLength(77);
  });

  it("keeps a single failure exactly as it was", () => {
    seed([
      makeMessage({
        id: "one",
        delivery: { state: "failed", detail: "Cannot send to channel" },
      }),
    ]);
    render(<Timeline view={TEST_VIEW} />);

    expect(screen.getByText("Not sent — Cannot send to channel")).toBeTruthy();
    expect(screen.queryByText("Not sent")).toBeNull();
  });

  it("sends the whole run again, in the order it was said", async () => {
    ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
    seed(stranded(3));
    render(<Timeline view={TEST_VIEW} />);

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(ipcMock.submitInput).toHaveBeenCalledTimes(3));
    expect(ipcMock.submitInput.mock.calls.map((call) => call[2])).toEqual([
      "paste line 1",
      "paste line 2",
      "paste line 3",
    ]);
  });
});
