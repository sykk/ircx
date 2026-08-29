import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ESTIMATED_ROW_PX, LOAD_OLDER_PX, Timeline } from "./Timeline";
import { makeConversation, makeMessage } from "./fixtures";
import { assignGroups } from "./groups";
import { buildRows } from "./rows";
import { CHARS_PER_LINE, LINE_PX, VIEWPORT_PX, flushLayout, installLayout, wrapAt } from "./layoutHarness";

/**
 * The timeline where the rows are uneven, which is every timeline the app draws
 * and none of the ones `Timeline.test.tsx` stubs. `layoutHarness` is the model;
 * what is asserted here is a pane's position rather than its content.
 */

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

// A landing here is two hundred rows measured over as many commits as a browser
// would take to measure them, and the model reports the first observation of
// every one of them. That is 1.5x what the model cost when it did not, and the
// slowest test in this file then runs past the default five seconds on a machine
// running the rest of the suite beside it.
vi.setConfig({ testTimeout: 20_000 });

beforeAll(installLayout);

/**
 * The virtualiser sets a timer on every scroll — `isScrollingResetDelay`, 150ms
 * — and nothing cancels it when the pane unmounts. So a file whose last test
 * scrolls and then returns hands vitest a timer with nothing to fire into: it
 * lands after the environment is torn down, `notify` reaches React and React
 * reaches `window`, and a run in which every test passed fails on an unhandled
 * `ReferenceError`. It is a race and this machine wins it; CI does not.
 *
 * Waited out here rather than cancelled, because the timer belongs to a
 * virtualiser this file has no handle on. By now testing-library's own cleanup
 * has unmounted the panes, so what it notifies reaches nobody.
 */
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
});

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
        configuredNick: "sable",
        currentNick: "sable",
        sasl: { state: "notConfigured" },
        capsEnabled: [],
        lagMs: null,
      },
    },
    timelines,
    replyTo: {},
  });
}

function seed(messages: ChatMessage[], unreadFrom: string | null = null) {
  seedTimelines({
    [KEY]: { messages, unreadFrom, readMarker: null, hasMore: true, loadingOlder: false, askedBehind: null, detachedAt: null },
  });
}

/** A second pane on the same channel, as a split would open. */
function openSecondView() {
  const id = "second-view";
  const { views, viewAnchor, viewOrder } = useAppStore.getState();
  useAppStore.setState({
    views: { ...views, [id]: { ...views[TEST_VIEW]!, id } },
    viewAnchor: { ...viewAnchor, [id]: null },
    viewOrder: [...viewOrder, id],
  });
  return id;
}

/** How far below the top of the viewport a message's own line is drawn. Rows are
 * laid out inside the sizer, which starts below the head, so the head has to be added
 * back before `scrollTop` can be taken off. */
function eyeLine(scroller: HTMLElement, msgid: string): number {
  const line = scroller.querySelector<HTMLElement>(`[data-msgid="${msgid}"]`);
  const row = line?.closest<HTMLElement>("[data-index]");
  if (!line || !row) throw new Error(`${msgid} is not drawn in this pane`);
  const head = scroller.querySelector<HTMLElement>('[data-testid="timeline-head"]');
  // The line's own place in the row and not the row's, which are the same
  // number until a landing page merges into the row and puts its messages above
  // this one inside it (#535).
  const within = line.getBoundingClientRect().top - row.getBoundingClientRect().top;
  return topOf(row) + within + (head?.offsetHeight ?? 0) - scroller.scrollTop;
}

function topOf(row: HTMLElement): number {
  return Number.parseFloat(row.style.transform.replace(/[^-\d.]/g, ""));
}

/** How tall a message's own line is, which a rewrap changes and the row's
 * height cannot be read for: a row is a run and every line in it grew. */
function linePx(scroller: HTMLElement, msgid: string): number {
  const line = scroller.querySelector<HTMLElement>(`[data-msgid="${msgid}"]`);
  if (!line) throw new Error(`${msgid} is not drawn in this pane`);
  return line.offsetHeight;
}

/** The message under the reader's eyes: the first one drawn at or below the top
 * of the viewport. Read off the pane rather than named by the test, because
 * which message that is depends on the heights being modelled. */
function atTheFold(scroller: HTMLElement): string {
  const head = scroller.querySelector<HTMLElement>('[data-testid="timeline-head"]');
  const headPx = head?.offsetHeight ?? 0;
  for (const line of scroller.querySelectorAll<HTMLElement>("[data-msgid]")) {
    const row = line.closest<HTMLElement>("[data-index]");
    if (row && topOf(row) + headPx >= scroller.scrollTop) return line.dataset.msgid!;
  }
  throw new Error("no message is drawn below the fold");
}

/** The message the reader is actually looking at: the first whose own *line* is
 * drawn at or below the top of the viewport. `atTheFold` above answers in rows,
 * which names a different message wherever the reader is parked inside one
 * (#608) — the row below theirs, whose top is the first at or under the fold. */
function lineAtTheFold(scroller: HTMLElement): string {
  for (const line of scroller.querySelectorAll<HTMLElement>("[data-msgid]")) {
    const msgid = line.dataset.msgid!;
    if (eyeLine(scroller, msgid) >= 0) return msgid;
  }
  throw new Error("no message's line is drawn below the fold");
}

/** The line the fold cuts through, which is who the anchor holds: the last
 * message whose own line starts at or above the top of the viewport (#608).
 * `lineAtTheFold` above is the one after it, and a rewrap moves them apart. */
function lineTheFoldCuts(scroller: HTMLElement): string {
  let cut: string | null = null;
  for (const line of scroller.querySelectorAll<HTMLElement>("[data-msgid]")) {
    const msgid = line.dataset.msgid!;
    if (eyeLine(scroller, msgid) > 0) break;
    cut = msgid;
  }
  if (cut === null) throw new Error("no message's line starts above the fold");
  return cut;
}

/** The page a scroll to the top is answered with, 200 messages behind the
 * window and with the same mix of lengths in it. */
function olderPage(seedNumber: number): ChatMessage[] {
  return makeConversation({
    count: 200,
    seed: seedNumber,
    startedAt: Date.parse("2026-07-28T00:00:00.000Z"),
  }).map((m) => ({ ...m, id: `old-${m.id}` }));
}

/**
 * A channel whose page boundary falls inside one person's run: `historian` says
 * the last line of the page and the first two of the window, so the two sides
 * are one block once both are drawn. The speaker function repeats where a run
 * happens to straddle the window boundary.
 *
 * Everything else alternates, so the block the reader opens is two messages
 * rather than the channel.
 */
function runAcrossTheBoundary(from: number, count: number): ChatMessage[] {
  const started = Date.parse("2026-07-28T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const run = n >= 200 && n <= 202;
    return makeMessage({
      id: `line${n}`,
      nick: run ? "historian" : ["archivist", "curator"][n % 2]!,
      text: `line ${String(n).padStart(4, "0")} the reader is somewhere above this line`,
      timestamp: new Date(started + n * 90).toISOString(),
    });
  });
}

/**
 * An alternating channel that keeps `groups.ts` out of the measurement: two
 * people alternating every line, nothing opening with `[` or with `nick:`, and
 * three body lengths sent back to back. No run is longer than a message, no
 * group is assigned, and every row is one or two lines.
 *
 * `source` is what the restore leaves behind it: the archive it read, then what
 * the server replayed on top, then what the session heard live — which is where
 * the two history rules in the window come from.
 */
function walkedChannel(
  count: number,
  from: number,
  startedAt: number,
  source: (index: number) => ChatMessage["source"],
): ChatMessage[] {
  const nicks = ["historian", "archivist"];
  const long =
    "the template loader will happily read /proc/self/environ and the credentials are right there in it";
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const body = n % 17 === 0 ? long : n % 5 === 0 ? "ack" : "heap layout after the second free";
    return makeMessage({
      id: `line${n}`,
      nick: nicks[n % 2]!,
      text: `line ${String(n).padStart(4, "0")} ${body}`,
      // 90ms apart, which is the rate the seeder sent them at.
      timestamp: new Date(startedAt + i * 90).toISOString(),
      source: source(i),
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.loadHistory.mockReturnValue(new Promise(() => {}));
  ipcMock.pageBack.mockResolvedValue("end");
  ipcMock.react.mockResolvedValue({ kind: "handled" });
  useAppStore.setState({ ...oneView(null), networks: {}, timelines: {}, typing: {} });
});

describe("a timeline whose rows are the heights it draws", () => {
  it("places a returning pane at its unread seam after layout is available", () => {
    const messages = makeConversation({ count: 512, seed: 3 });
    seed(messages, messages[500]!.id);
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
    let laidOut = false;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testid === "timeline-scroller" && !laidOut) return 0;
        return this.offsetHeight;
      },
    });

    try {
      const { rerender } = render(<Timeline view={TEST_VIEW} />);
      const scroller = screen.getByTestId("timeline-scroller");
      expect(scroller.scrollTop).toBe(0);

      laidOut = true;
      rerender(<Timeline view={TEST_VIEW} />);
      flushLayout();

      expect(scroller.scrollTop).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    }
  });

  it("draws rows the estimate is wrong about, in both directions", () => {
    // The guard on everything below. A model that flattened back to the
    // estimate would leave every assertion in this file true of nothing.
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);

    const heights = [...document.querySelectorAll<HTMLElement>("[data-index]")].map(
      (row) => row.offsetHeight,
    );
    expect(heights.length).toBeGreaterThan(5);
    expect(new Set(heights).size).toBeGreaterThan(2);
    expect(heights.some((px) => px > ESTIMATED_ROW_PX)).toBe(true);
    expect(heights.some((px) => px < ESTIMATED_ROW_PX)).toBe(true);
  });

  it("holds the reader still while a page of history lands above them", async () => {
    ipcMock.loadHistory.mockResolvedValue(olderPage(7));
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const reading = atTheFold(scroller);
    const before = eyeLine(scroller, reading);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    expect(eyeLine(scroller, reading)).toBe(before);
  });

  /**
   * #532, and the geometry is the whole of what tells it from the test above.
   * There the reader is a hundred pixels down; here they are against the top of
   * the content, which is where a pane asks for a page at all — so the head is
   * drawn above them and leaves on the very commit the page prepends.
   *
   * `scrollAnchor.ts` says that departure "needs no term of its own: it leaves
   * on the commit that prepends the page, where the offsets on both sides are
   * measured from the top of the scroller and carry it". The write can be
   * exact while later measurement commits still move the reader.
   */
  it("holds the reader still when the page lands under a head that is leaving", async () => {
    ipcMock.loadHistory.mockResolvedValue(olderPage(7));
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    // The head the ask puts up, which is the row this case turns on. `getByTestId`
    // throws where there is none, so asking for it is the assertion.
    screen.getByTestId("timeline-head");
    const reading = atTheFold(scroller);
    const before = eyeLine(scroller, reading);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    expect(eyeLine(scroller, reading)).toBe(before);
  });

  /**
   * #535: the pane that asked was at the top of its content, the page landed
   * with a message by the same person a moment
   * earlier, and the reader's own line was drawn 84px lower afterwards.
   *
   * The page boundary falls inside one person's run here, so `groups.ts` draws
   * the two sides as one block once both are in the window — and the reader's
   * message, which opened the block, is now the second message in it. The row's
   * top is no longer just above their line, and holding the row still leaves the
   * line a message lower.
   */
  it("holds the reader still when the page merges into the run they are reading", async () => {
    ipcMock.loadHistory.mockResolvedValue(runAcrossTheBoundary(1, 200));
    seed(runAcrossTheBoundary(201, 200));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();

    const scroller = screen.getByTestId("timeline-scroller");
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    const reading = atTheFold(scroller);
    const before = eyeLine(scroller, reading);

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(400),
    );
    flushLayout();

    // The merge itself, which is what makes this a different test from the one
    // above rather than the same one with another fixture.
    const row = scroller
      .querySelector(`[data-msgid="${reading}"]`)!
      .closest<HTMLElement>("[data-index]")!;
    expect(row.querySelector("[data-msgid]")!.getAttribute("data-msgid")).not.toBe(reading);

    expect(eyeLine(scroller, reading)).toBe(before);
  });
});

/**
 * #508. Two panes on one conversation, one of them parked in the middle of the
 * archive with nobody touching it, and about one landing in four moved it by a
 * line of text.
 *
 * The pane that asked for the page is not the only one the ask reaches: the
 * archive lands in both of them, and the parked pane sees a page it did not ask
 * for arrive above a reader who is not there. What it no longer sees is the
 * head saying so, that being the pane's own report and not the conversation's
 * (#516).
 */
describe("two panes on one channel, one of them parked", () => {
  /** The read the reader's scroll asks for, held open the way a round trip
   * holds it: the head goes up in both panes and stays up until this is
   * answered. A page resolved before the render commits never draws one. */
  function heldOpen(page: ChatMessage[]) {
    let land = () => {};
    ipcMock.loadHistory.mockReturnValue(
      new Promise<ChatMessage[]>((resolve) => {
        land = () => resolve(page);
      }),
    );
    return () => land();
  }

  /** The pane the reader is scrolling and the one nobody is touching, both on
   * the channel the page is going to land in. The parked one is left in the
   * middle of what it holds, far enough down that it asks for no history of its
   * own and far enough up that it is not following the live edge. */
  function twoPanes() {
    seed(makeConversation({ count: 400, seed: 3 }));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [reading, parked] = screen.getAllByTestId("timeline-scroller");
    parked!.scrollTop = 4_000;
    fireEvent.scroll(parked!);
    flushLayout();
    return { reading: reading!, parked: parked! };
  }

  it("draws no head for a read it did not ask for", () => {
    const { reading, parked } = twoPanes();
    heldOpen(olderPage(11));

    reading.scrollTop = 100;
    fireEvent.scroll(reading);
    flushLayout();

    expect(within(reading).getByText("Loading older messages")).toBeTruthy();
    expect(within(parked).queryByText("Loading older messages")).toBeNull();
  });

  it("draws it in a pane owed the page a read already out will answer", async () => {
    const { reading, parked } = twoPanes();
    const land = heldOpen(olderPage(11));

    reading.scrollTop = 100;
    fireEvent.scroll(reading);
    flushLayout();
    // The second reader scrolls to the top while that read is in flight. Their
    // pane asks and is told a page is already coming, which is an answer it is
    // owed too — so it is waiting, and says so.
    parked.scrollTop = 100;
    fireEvent.scroll(parked);
    flushLayout();

    expect(within(parked).getByText("Loading older messages")).toBeTruthy();

    land();
    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    await waitFor(() =>
      expect(within(parked).queryByText("Loading older messages")).toBeNull(),
    );
  });

  it("leaves the parked pane's page where it was while the other pane asks", () => {
    const { reading, parked } = twoPanes();
    heldOpen(olderPage(11));
    const watching = atTheFold(parked);
    const before = eyeLine(parked, watching);

    reading.scrollTop = 100;
    fireEvent.scroll(reading);
    flushLayout();

    expect(eyeLine(parked, watching)).toBe(before);
  });

  it("leaves it where it was when the page lands", async () => {
    const { reading, parked } = twoPanes();
    const land = heldOpen(olderPage(11));

    reading.scrollTop = 100;
    fireEvent.scroll(reading);
    flushLayout();
    // Read with the read out, which is where the parked reader's eyes were for
    // the whole of the round trip.
    const watching = atTheFold(parked);
    const before = eyeLine(parked, watching);

    land();
    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    expect(eyeLine(parked, watching)).toBe(before);
  });
});

/**
 * #508's conditions: a restored layout with both panes on the channel, the
 * right one wheeled up the archive and then left alone while the left one pages
 * twice.
 *
 * The pane does not move here, and the negative is the useful part. Whatever
 * displaces it in the release app, it is not the head arriving or leaving, not
 * the anchor's placement, not the restore's `scrollToIndex` still reconciling,
 * and not a history rule landing above the reader — all four are in this test
 * and the pane holds through them.
 *
 * This channel has no row whose height can change after it is drawn. Keeping
 * `groups.ts` out of the measurement also means no group is ever assigned and
 * no run is longer than a message, so a page landing cannot alter a row that
 * that is already on the screen.
 */
describe("a parked pane without regrouping", () => {
  const ARCHIVE = Date.parse("2026-07-29T00:00:00.000Z");

  /** The two panes as a restore brings them back, each aimed at the row its
   * reader was left on. */
  function restoredPanes(messages: ChatMessage[]) {
    seed(messages);
    const second = openSecondView();
    const rows = buildRows(
      messages,
      null,
      { nick: "sable", words: [], hushed: [] },
      assignGroups(messages, []),
      new Set<string>(),
    );
    useAppStore.setState({
      viewAnchor: {
        [TEST_VIEW]: rows[Math.floor(rows.length * 0.8)]!.id,
        [second]: rows[Math.floor(rows.length * 0.55)]!.id,
      },
    });
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [reading, parked] = screen.getAllByTestId("timeline-scroller");
    // The wheel hands each pane to its reader; from here neither is being put
    // back.
    fireEvent.wheel(reading!);
    fireEvent.wheel(parked!);
    parked!.scrollTop = 4_000;
    fireEvent.scroll(parked!);
    flushLayout();
    return { reading: reading!, parked: parked! };
  }

  it("leaves the parked pane where it was across two landings", async () => {
    const { reading, parked } = restoredPanes(
      walkedChannel(400, 1_000, ARCHIVE, (i) =>
        i < 200 ? "localArchive" : i < 350 ? "serverHistory" : "live",
      ),
    );

    for (const page of [0, 1]) {
      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.loadingOlder).toBe(false),
      );
      const held = useAppStore.getState().timelines[KEY]!.messages.length;
      let land = () => {};
      ipcMock.loadHistory.mockReturnValue(
        new Promise<ChatMessage[]>((resolve) => {
          // Half of it the archive's and half the server's, which is what a
          // page-back reaching past the archive comes back as.
          land = () =>
            resolve(
              walkedChannel(
                200,
                1_000 - 200 * (page + 1),
                ARCHIVE - (page + 1) * 3_600_000,
                (i) => (i < 100 ? "localArchive" : "serverHistory"),
              ),
            );
        }),
      );
      const asksBefore = ipcMock.loadHistory.mock.calls.length;

      reading.scrollTop = 100 + page;
      fireEvent.scroll(reading);
      flushLayout();
      await waitFor(() => expect(ipcMock.loadHistory).toHaveBeenCalledTimes(asksBefore + 1));

      const watching = atTheFold(parked);
      const before = eyeLine(parked, watching);
      await act(async () => land());
      await waitFor(() =>
        expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(held + 200),
      );
      flushLayout();

      expect(eyeLine(parked, watching)).toBe(before);
    }
  });
});

/**
 * The case the channel above cannot express: a row that changes height after it
 * has been drawn.
 *
 * A declared group runs forward from the message that named it until the
 * conversation stops for `DECLARED_GAP_MS`, and the same name said again
 * rejoins the group rather than opening a second one. So a page-back landing
 * against the window — the page's last message seconds before the window's
 * first, which is what paging back through a busy channel gives — can carry the
 * same topic somebody declared inside the window. The group is then already
 * open by the time the window's own declaration is reached, and the block that
 * was drawing the topic's name stops drawing it.
 *
 * That block is above a parked reader, and it loses a line of text where it
 * stands. Nobody scrolled and nothing was inserted: a row already on the screen
 * is one line shorter than it was.
 */
describe("a page that regroups the window it lands above", () => {
  const WINDOW_AT = Date.parse("2026-07-29T00:00:00.000Z");
  const TOPIC = "[heap] chunk is on the tcache list twice";

  /** Ten seconds a line, two people, and one of them naming a topic. */
  function talk(count: number, from: number, startedAt: number, declaresAt: number) {
    const nicks = ["historian", "archivist"];
    return Array.from({ length: count }, (_, i) =>
      makeMessage({
        id: `line${from + i}`,
        nick: nicks[(from + i) % 2]!,
        text: i === declaresAt ? TOPIC : `line ${from + i} heap layout after the second free`,
        timestamp: new Date(startedAt + i * 10_000).toISOString(),
      }),
    );
  }

  /** Where the block holding a message is drawn inside its pane. */
  function rowOf(scroller: HTMLElement, msgid: string): HTMLElement {
    const row = scroller
      .querySelector(`[data-msgid="${msgid}"]`)
      ?.closest<HTMLElement>("[data-index]");
    if (!row) throw new Error(`${msgid} is not drawn in this pane`);
    return row;
  }

  it("holds the parked reader while the window's topic stops opening", async () => {
    // The parked reader sits a few rows under the block that declared the
    // topic — close enough that it is still drawn, because a row nobody has
    // mounted is never measured and cannot change height under anybody.
    seed(talk(400, 1_000, WINDOW_AT, 100));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [reading, parked] = screen.getAllByTestId("timeline-scroller");
    // Both panes open at the live edge, so the pane is walked back to the block
    // that declared the topic and then parked a few rows under it.
    parked!.scrollTop = 100 * ESTIMATED_ROW_PX;
    fireEvent.scroll(parked!);
    flushLayout();
    parked!.scrollTop = topOf(rowOf(parked!, "line1100")) + 300;
    fireEvent.scroll(parked!);
    flushLayout();

    // The precondition, asserted rather than assumed: the block that declared
    // the topic is drawn, it is above the reader, and it is drawing the name.
    const declaring = rowOf(parked!, "line1100");
    expect(topOf(declaring)).toBeLessThan(parked!.scrollTop);
    expect(declaring.querySelectorAll('[data-ui="group-name"]')).toHaveLength(1);

    let land = () => {};
    ipcMock.loadHistory.mockReturnValue(
      new Promise<ChatMessage[]>((resolve) => {
        // Ends ten seconds before the window starts, and names the same topic.
        land = () => resolve(talk(200, 800, WINDOW_AT - 200 * 10_000, 190));
      }),
    );

    reading!.scrollTop = 100;
    fireEvent.scroll(reading!);
    flushLayout();

    const watching = atTheFold(parked!);
    const before = eyeLine(parked!, watching);
    land();
    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    // The row above the reader gave the name up, which is the line it lost.
    expect(rowOf(parked!, "line1100").querySelectorAll('[data-ui="group-name"]')).toHaveLength(0);
    expect(eyeLine(parked!, watching)).toBe(before);
  });
});

/**
 * The band it needs is real and narrow: a pane closer than `LOAD_OLDER_PX` to
 * the top of its content asks for that page itself and is the asker, and a pane
 * further down than the arriving page can reach holds nothing a merge could
 * move. Pointer-wheel steps cannot reliably park inside that narrow band.
 *
 * The two are only irreconcilable while a row is a message tall. A block of
 * twenty is 400px of one row, so a reader sitting inside it is past the
 * threshold and inside the row the page merges into at the same time — and that
 * is the shape a channel talking in runs actually has.
 */
describe("a neighbour parked inside the run the arriving page merges into", () => {
  /** A run long enough to sit inside: `historian` says the last eleven lines of
   * the page and the first twenty of the window, so the block at the top of the
   * window is 400px of row before the page has landed anything in it. */
  function longRunAcrossTheBoundary(from: number, count: number): ChatMessage[] {
    const started = Date.parse("2026-07-28T00:00:00.000Z");
    return Array.from({ length: count }, (_, i) => {
      const n = from + i;
      const run = n >= 190 && n <= 220;
      return makeMessage({
        id: `line${n}`,
        nick: run ? "historian" : ["archivist", "curator"][n % 2]!,
        text: `line ${String(n).padStart(4, "0")} the reader is somewhere in this run`,
        timestamp: new Date(started + n * 90).toISOString(),
      });
    });
  }

  it("holds the parked reader whose own row takes the page in", async () => {
    seed(longRunAcrossTheBoundary(201, 400));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [reading, parked] = screen.getAllByTestId("timeline-scroller");
    // Both panes open at the live edge, so the pane is walked back to the top of
    // the window first — and stopped short of the threshold on the way, because
    // a pane that reaches it asks for the page itself and is the asker.
    parked!.scrollTop = LOAD_OLDER_PX + 200;
    fireEvent.scroll(parked!);
    flushLayout();
    const opening = parked!
      .querySelector('[data-msgid="line201"]')!
      .closest<HTMLElement>("[data-index]")!;
    // Inside that block and past the threshold, which is the whole of the band.
    // Written as the block's own geometry rather than as a number: what a row
    // measures is the model's to decide, and a test naming 450 would stop being
    // about the band the day a line wrapped.
    parked!.scrollTop = topOf(opening) + opening.offsetHeight - 100;
    fireEvent.scroll(parked!);
    flushLayout();

    expect(parked!.scrollTop).toBeGreaterThan(LOAD_OLDER_PX);
    expect(topOf(opening)).toBeLessThan(parked!.scrollTop);
    expect(topOf(opening) + opening.offsetHeight).toBeGreaterThan(parked!.scrollTop);

    let land = () => {};
    ipcMock.loadHistory.mockReturnValue(
      new Promise<ChatMessage[]>((resolve) => {
        land = () => resolve(longRunAcrossTheBoundary(1, 200));
      }),
    );

    reading!.scrollTop = 100;
    fireEvent.scroll(reading!);
    flushLayout();

    const watching = atTheFold(parked!);
    const before = eyeLine(parked!, watching);
    // The reader's own line inside the merging row, which is the reading the
    // fold cannot give: the fold names the row below this one.
    const inside = eyeLine(parked!, "line201");

    land();
    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]!.messages).toHaveLength(600),
    );
    flushLayout();

    // The merge, asserted rather than assumed: the block the reader is inside
    // opens with a message the page brought.
    expect(
      parked!
        .querySelector('[data-msgid="line201"]')!
        .closest<HTMLElement>("[data-index]")!
        .querySelector("[data-msgid]")!
        .getAttribute("data-msgid"),
    ).toBe("line190");

    expect(eyeLine(parked!, "line201")).toBe(inside);
    expect(eyeLine(parked!, watching)).toBe(before);
  });

  /**
   * #608, which was the anchor holding the first message of the reader's row:
   * where that row is a run of twenty it is nowhere near the line they are
   * reading, and a page merging in between the two moved a live reader 618px in
   * a browser trace while every term the anchor computed read held.
   *
   * Nothing has to arrive for that gap to open. A line already in the row
   * getting taller does it too, and needs no landing, no merge and no
   * re-ordering: the row's top does not move, so the correction was not short
   * here — it was never asked for, `movedInList` being false for a message that
   * only changed height. The `grown` branch is what asks.
   *
   * The same arrangement in `webkit2gtk-4.1` moved the fold 46px while the
   * anchor's message did not move. The model was not manufacturing the defect.
   */
  it("holds the parked reader when a line above them grows", () => {
    seed(longRunAcrossTheBoundary(201, 400));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [, parked] = screen.getAllByTestId("timeline-scroller");
    parked!.scrollTop = LOAD_OLDER_PX + 200;
    fireEvent.scroll(parked!);
    flushLayout();
    const opening = parked!
      .querySelector('[data-msgid="line201"]')!
      .closest<HTMLElement>("[data-index]")!;
    parked!.scrollTop = topOf(opening) + opening.offsetHeight - 100;
    fireEvent.scroll(parked!);
    flushLayout();

    expect(parked!.scrollTop).toBeGreaterThan(LOAD_OLDER_PX);
    expect(topOf(opening)).toBeLessThan(parked!.scrollTop);
    expect(topOf(opening) + opening.offsetHeight).toBeGreaterThan(parked!.scrollTop);

    // The line under the reader's eyes, and the line the anchor is holding,
    // which are the two readings the trace disagreed on.
    const watching = lineAtTheFold(parked!);
    const before = eyeLine(parked!, watching);
    const anchored = eyeLine(parked!, "line201");

    // A message the reader has already scrolled past gains two wrapped lines:
    // inside their row, above their eyes, and below the message the anchor
    // holds. `line205` is drawn above the fold, which is asserted rather than
    // assumed — where the reader sits inside the run is the model's to decide.
    const grown = useAppStore.getState().timelines[KEY]!.messages.find((m) => m.id === "line205")!;
    expect(eyeLine(parked!, "line205")).toBeLessThan(0);
    act(() => {
      useAppStore.getState().applyEvent({
        type: "messageUpdated",
        message: { ...grown, text: `${grown.text} ${"and then it was said again ".repeat(4)}` },
      });
    });
    flushLayout();

    // The reader's own line is exactly where it was, and the message the row is
    // named for has gone up by the two lines the pane came down — which is the
    // fix stated as a reading: the first message of a run is not the reader.
    expect(eyeLine(parked!, watching)).toBe(before);
    expect(eyeLine(parked!, "line201")).toBe(anchored - 2 * LINE_PX);
  });

  /**
   * #608's second way in, and it lands on the same floor. A gap fill is history
   * sorting into the *middle* of what is held rather than in front of it — a
   * page-back answers before the window, a fill answers inside it — so it goes
   * into the reader's row between the message the anchor holds and the line
   * they are reading.
   *
   * This one needs no branch of its own. A fill that lands above the reader's
   * eyes lands in front of the message at the fold however far behind the row's
   * first message it is, so naming the reader by their own line is the whole of
   * what makes `movedInList` true and the existing correction run.
   */
  it("holds the parked reader when a gap fill lands inside their row", () => {
    // Read back rather than lived through, because `rows.ts` closes the open
    // run where `source` changes: a fill is history, and history landing in a
    // window of live messages opens a row of its own rather than joining
    // theirs. The arrangement exists only where the two are the same kind.
    seed(longRunAcrossTheBoundary(201, 400).map((m) => ({ ...m, source: "serverHistory" as const })));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [, parked] = screen.getAllByTestId("timeline-scroller");
    parked!.scrollTop = LOAD_OLDER_PX + 200;
    fireEvent.scroll(parked!);
    flushLayout();
    const opening = parked!
      .querySelector('[data-msgid="line201"]')!
      .closest<HTMLElement>("[data-index]")!;
    parked!.scrollTop = topOf(opening) + opening.offsetHeight - 100;
    fireEvent.scroll(parked!);
    flushLayout();

    const watching = lineAtTheFold(parked!);
    const before = eyeLine(parked!, watching);
    const anchored = eyeLine(parked!, "line201");
    expect(eyeLine(parked!, "line205")).toBeLessThan(0);

    // Four lines the reader never saw, stamped between two they have already
    // read past. The same speaker, so `groups.ts` keeps the run one row and
    // this is a fill inside the reader's own block rather than a new one.
    const held = useAppStore.getState().timelines[KEY]!.messages;
    const at = Date.parse(held.find((m) => m.id === "line205")!.timestamp);
    const fill = Array.from({ length: 4 }, (_, i) =>
      makeMessage({
        id: `fill${i}`,
        nick: "historian",
        // One wrapped line each, so the displacement below is four of them and
        // not eight.
        text: `the fill ${i}, behind what the reader has read`,
        timestamp: new Date(at + i + 1).toISOString(),
        source: "serverHistory",
      }),
    );
    act(() => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        answers: null,
        network: "libera",
        target: "#ctf-ops",
        messages: fill,
      });
    });
    flushLayout();

    // The fill is where it was aimed: inside the reader's own row, above their
    // eyes and below the message the anchor holds.
    expect(
      parked!.querySelector('[data-msgid="fill0"]')!.closest<HTMLElement>("[data-index]"),
    ).toBe(parked!.querySelector('[data-msgid="line201"]')!.closest<HTMLElement>("[data-index]"));
    expect(eyeLine(parked!, "fill0")).toBeLessThan(0);

    expect(eyeLine(parked!, watching)).toBe(before);
    expect(eyeLine(parked!, "line201")).toBe(anchored - 4 * LINE_PX);
  });

  /**
   * #608's third way in, and the one that needs nothing unusual to have
   * happened. The reader has not paged anything back: they have scrolled up in
   * a channel that is still talking, and a line arrives stamped behind what is
   * already held — a relay, a bridge, or a server whose clock moved.
   * `insertionPoint` puts it at its own time, which is inside the run the
   * reader is sitting in.
   *
   * Live on both sides, so the `source` rule that keeps a gap fill out of a
   * live window does not apply here: the line joins the run rather than opening
   * one, and there is nothing about the arrangement a reader could avoid.
   */
  it("holds the parked reader when a live line is stamped into their row", () => {
    seed(longRunAcrossTheBoundary(201, 400));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [, parked] = screen.getAllByTestId("timeline-scroller");
    parked!.scrollTop = LOAD_OLDER_PX + 200;
    fireEvent.scroll(parked!);
    flushLayout();
    const opening = parked!
      .querySelector('[data-msgid="line201"]')!
      .closest<HTMLElement>("[data-index]")!;
    parked!.scrollTop = topOf(opening) + opening.offsetHeight - 100;
    fireEvent.scroll(parked!);
    flushLayout();

    const watching = lineAtTheFold(parked!);
    const before = eyeLine(parked!, watching);
    const anchored = eyeLine(parked!, "line201");
    expect(eyeLine(parked!, "line205")).toBeLessThan(0);

    const held = useAppStore.getState().timelines[KEY]!.messages;
    const at = Date.parse(held.find((m) => m.id === "line205")!.timestamp);
    act(() => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        answers: null,
        network: "libera",
        target: "#ctf-ops",
        messages: [
          makeMessage({
            id: "late",
            nick: "historian",
            text: "a line said a moment ago and stamped a while back",
            timestamp: new Date(at + 1).toISOString(),
          }),
        ],
      });
    });
    flushLayout();

    // In the reader's own row, above their eyes, and behind the message the
    // anchor holds — which is the whole arrangement.
    expect(parked!.querySelector('[data-msgid="late"]')!.closest<HTMLElement>("[data-index]")).toBe(
      parked!.querySelector('[data-msgid="line201"]')!.closest<HTMLElement>("[data-index]"),
    );
    expect(eyeLine(parked!, "late")).toBeLessThan(0);

    expect(eyeLine(parked!, watching)).toBe(before);
    expect(eyeLine(parked!, "line201")).toBe(anchored - LINE_PX);
  });

  /**
   * And the other side of it, which is where #608 stops. The same line, stamped
   * a moment *earlier* — in front of the message the anchor holds rather than
   * behind it.
   *
   * Now the anchor's own message moves in the list, `movedInList` is true, and
   * the branch that puts the reader back runs: `tookIn` reads the line's height
   * because the reader's line really did move down inside its row, and the
   * write cancels it. **The reader holds, and this test asserts what should
   * happen rather than what does.**
   *
   * Which is what makes the three tests above one defect and not a broken
   * anchor: the correction works, and it is asked for only when something lands
   * in front of the one message the anchor is watching.
   */
  it("holds the parked reader when the same line is stamped in front of the anchor's own", () => {
    seed(longRunAcrossTheBoundary(201, 400));
    const second = openSecondView();
    render(
      <>
        <Timeline view={TEST_VIEW} />
        <Timeline view={second} />
      </>,
    );
    flushLayout();

    const [, parked] = screen.getAllByTestId("timeline-scroller");
    parked!.scrollTop = LOAD_OLDER_PX + 200;
    fireEvent.scroll(parked!);
    flushLayout();
    const opening = parked!
      .querySelector('[data-msgid="line201"]')!
      .closest<HTMLElement>("[data-index]")!;
    parked!.scrollTop = topOf(opening) + opening.offsetHeight - 100;
    fireEvent.scroll(parked!);
    flushLayout();

    const watching = lineAtTheFold(parked!);
    const before = eyeLine(parked!, watching);

    const held = useAppStore.getState().timelines[KEY]!.messages;
    const at = Date.parse(held.find((m) => m.id === "line201")!.timestamp);
    act(() => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        answers: null,
        network: "libera",
        target: "#ctf-ops",
        messages: [
          makeMessage({
            id: "earlier",
            nick: "historian",
            text: "a line said a moment ago and stamped a while further back",
            timestamp: new Date(at - 1).toISOString(),
          }),
        ],
      });
    });
    flushLayout();

    // In front of the anchor's message, in the same row, which is what makes
    // this the same event as the test above and not another one.
    expect(
      parked!.querySelector('[data-msgid="earlier"]')!.closest<HTMLElement>("[data-index]"),
    ).toBe(parked!.querySelector('[data-msgid="line201"]')!.closest<HTMLElement>("[data-index]"));

    expect(eyeLine(parked!, watching)).toBe(before);
  });
});

describe("a row that grows under the reader following it", () => {
  /** How much of the last row is drawn below the bottom of the pane. What #594
   * photographed is a sentence that is: the clock over the line on the screen
   * and the line itself off the bottom. */
  function belowTheFold(scroller: HTMLElement): number {
    const last = [...scroller.querySelectorAll<HTMLElement>("[data-index]")].at(-1)!;
    const head = scroller.querySelector<HTMLElement>('[data-testid="timeline-head"]');
    const bottom = topOf(last) + last.offsetHeight + (head?.offsetHeight ?? 0);
    return Math.max(0, bottom - (scroller.scrollTop + scroller.clientHeight));
  }

  /** The reader's own line, stamped after everything the channel already holds:
   * a message older than the tail is sorted in where it belongs, and a line that
   * lands in the middle of the window is a different case with a different
   * answer. */
  function said(): ChatMessage {
    const held = useAppStore.getState().timelines[KEY]!.messages;
    return makeMessage({
      id: "mine",
      nick: "sable",
      text: "a line typed with the reader already at the tail",
      timestamp: new Date(Date.parse(held.at(-1)!.timestamp) + 1000).toISOString(),
      delivery: { state: "sent" },
    });
  }

  function append(message: ChatMessage) {
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [message],
    });
  }

  function refuse(message: ChatMessage) {
    useAppStore.getState().applyEvent({
      type: "messageUpdated",
      message: {
        ...message,
        delivery: { state: "failed", detail: "Cannot send to channel (+m)" },
      },
    });
  }

  /**
   * #599, where the model is the thing under test. A `+m` channel refuses a line
   * a moment after it was sent, and the row the reader is already following
   * gains the reason and the retry under it — in a later commit than the one it
   * mounted in, which is the arrangement a loopback server cannot produce and a
   * proxy holding the refusal back can.
   *
   * The release app draws the whole of it, walked under `Xvfb` at 3ms, 301ms and
   * 2001ms. What the model did was leave the pane a line short of the row's
   * bottom for good, because the only thing it counted as scrollable was the
   * sizer and the sizer is a commit behind the row that grew.
   */
  it("follows a row that gains a line after it was measured", () => {
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    expect(belowTheFold(scroller)).toBe(0);

    const mine = said();
    act(() => append(mine));
    flushLayout();
    const row = scroller
      .querySelector('[data-msgid="mine"]')!
      .closest<HTMLElement>("[data-index]")!;
    const sent = row.offsetHeight;
    expect(belowTheFold(scroller)).toBe(0);

    act(() => refuse(mine));
    flushLayout();

    // That the row grew is asserted rather than assumed: a refusal drawn in the
    // same space would leave the reading below true of nothing.
    expect(row.offsetHeight).toBeGreaterThan(sent);
    expect(belowTheFold(scroller)).toBe(0);
  });

  /**
   * #594, which is not the case above and is the same shortfall. The refusal
   * lands within a millisecond of the line that provoked it, so both rows are
   * added in one commit and the follow effect runs once for the pair — against
   * the estimate the new rows are still drawn at.
   *
   * What the walk photographed is the refusal's clock on screen with its
   * sentence below the fold, in a pane that stays there: two frames two seconds
   * apart are the same picture, and a later line from another client scrolls in
   * normally, so the pane is still following.
   */
  it("follows two rows that arrive in one commit", () => {
    seed(makeConversation({ count: 400, seed: 3 }));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    expect(belowTheFold(scroller)).toBe(0);

    const mine = said();
    // The channel's own account of why the line did not go: `on_other_numeric`
    // files the numeric under the channel as a `server` row, which joins no run
    // and so opens a block of its own — a clock on one line and the sentence on
    // the next, where the estimate is one line and no clock.
    const refusal = makeMessage({
      id: "refused",
      kind: "server",
      nick: "irc.libera.chat",
      text: "Cannot send to channel (+m)",
      timestamp: new Date(Date.parse(mine.timestamp) + 1).toISOString(),
    });
    act(() => {
      append(mine);
      append(refusal);
    });
    flushLayout();

    // The refusal has to be taller than the estimate for the reading below to be
    // about anything: the pane is only left short by the difference.
    const row = scroller
      .querySelector('[data-msgid="refused"]')!
      .closest<HTMLElement>("[data-index]")!;
    expect(row.offsetHeight).toBeGreaterThan(ESTIMATED_ROW_PX);
    expect(belowTheFold(scroller)).toBe(0);
  });
});

describe("a row above the reader that grows, which is not the row they are in", () => {
  const STARTED = Date.parse("2026-07-29T00:00:00.000Z");

  /**
   * Parks a pane well past `LOAD_OLDER_PX`, then moves it one step, because the
   * virtualiser's guard on a row it re-measures reads which way the reader is
   * going and nothing else: it compensates a row entirely above the fold going
   * forward and declines the same row going backward, to head off a cascade of
   * its own. The wheel first is the pane being handed to its reader.
   */
  function park(scroller: HTMLElement, direction: "forward" | "backward") {
    fireEvent.wheel(scroller);
    scroller.scrollTop = LOAD_OLDER_PX + 3_000;
    fireEvent.scroll(scroller);
    flushLayout();
    scroller.scrollTop += direction === "backward" ? -60 : 60;
    fireEvent.scroll(scroller);
    flushLayout();
  }

  /** A message the reader has read past, in a row of its own that is wholly
   * above the fold — which is what makes this #611 and not #608. */
  function readPast(scroller: HTMLElement, fold: string): string {
    const foldRow = scroller
      .querySelector(`[data-msgid="${fold}"]`)!
      .closest<HTMLElement>("[data-index]")!;
    const above = [...scroller.querySelectorAll<HTMLElement>("[data-msgid]")].filter((line) => {
      const row = line.closest<HTMLElement>("[data-index]")!;
      return row !== foldRow && topOf(row) + row.offsetHeight < scroller.scrollTop;
    });
    const read = above.at(-2);
    if (!read) throw new Error("no row is drawn wholly above the fold");
    return read.dataset.msgid!;
  }

  function grow(msgid: string) {
    const message = useAppStore.getState().timelines[KEY]!.messages.find((m) => m.id === msgid)!;
    act(() => {
      useAppStore.getState().applyEvent({
        type: "messageUpdated",
        message: { ...message, text: `${message.text} ${"and then it was said again ".repeat(4)}` },
      });
    });
    flushLayout();
  }

  /**
   * #611. A line the reader has already scrolled past gains two lines — a
   * reaction arriving on it, a preview finishing, a delivery failure gaining
   * its reason — and the conversation below it comes down by that much under
   * eyes that asked for none of it.
   *
   * Both directions are asserted because the two are answered by different
   * things and the reader cannot tell them apart. Going forward the virtualiser
   * corrects the pane itself and the anchor finds it already there; going
   * backward the virtualiser declines and the anchor is what puts the reader
   * back.
   *
   * The same arrangement in `webkit2gtk-4.1`, one 60px step each way with a
   * 46px growth fired from the scroll listener, moved the reader's line by the
   * 60px requested and nothing else.
   */
  for (const direction of ["forward", "backward"] as const) {
    it(`holds the reader while they are scrolling ${direction}`, () => {
      seed(walkedChannel(400, 1_000, STARTED, () => "live"));
      render(<Timeline view={TEST_VIEW} />);
      flushLayout();
      const scroller = screen.getByTestId("timeline-scroller");
      park(scroller, direction);

      const watching = lineAtTheFold(scroller);
      const before = eyeLine(scroller, watching);
      const read = readPast(scroller, watching);
      expect(read).not.toBe(watching);

      grow(read);

      expect(eyeLine(scroller, watching)).toBe(before);
    });
  }

  /**
   * And what pays the pane back is still the reader's own scrolling to spend.
   * The rule this replaced declined every re-measurement going backward, so the
   * risk it was guarding against is a pane that answers a scroll up by putting
   * the reader back where they were trying to leave.
   *
   * Asserted in the conversation rather than in `scrollTop`, because the two
   * are not the same claim: scrolling up brings rows into the window that were
   * estimates, and a pane paying for the first sight of them is `scrollTop`
   * moving to hold the very line this asks about.
   */
  it("goes where the reader takes it after the growth", () => {
    seed(walkedChannel(400, 1_000, STARTED, () => "live"));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    park(scroller, "backward");
    const watching = lineAtTheFold(scroller);
    grow(readPast(scroller, watching));
    const before = eyeLine(scroller, watching);

    fireEvent.wheel(scroller);
    scroller.scrollTop -= 200;
    fireEvent.scroll(scroller);
    flushLayout();

    expect(eyeLine(scroller, watching)).toBe(before + 200);
  });
});

describe("a pane that gets narrower under the reader", () => {
  // The width is the model's and outlives a test, so a second one would open on
  // a pane the first left narrow.
  beforeEach(() => wrapAt(CHARS_PER_LINE));

  /**
   * A run long enough to park inside, at the end of the channel rather than the
   * start of it, and every line long enough to take two once the pane narrows.
   *
   * At the end because a reader parked near the top of the content is a reader
   * the history head is about to arrive over, and a head arriving is #508 — a
   * different case with a different answer, which moves the pane by exactly the
   * one line a rewrap would be measured in.
   */
  function aRunToSitIn(from: number, count: number): ChatMessage[] {
    const started = Date.parse("2026-07-28T00:00:00.000Z");
    const opens = from + count - 60;
    return Array.from({ length: count }, (_, i) => {
      const n = from + i;
      return makeMessage({
        id: `line${n}`,
        nick: n >= opens ? "historian" : ["archivist", "curator"][n % 2]!,
        text: `line ${String(n).padStart(4, "0")} the reader is somewhere in this run`,
        timestamp: new Date(started + n * 90).toISOString(),
      });
    });
  }

  /** Parks the reader inside the run rather than at the top of a row, which is
   * where the two answers below differ: everything above them is the
   * virtualiser's to pay for and their own row is the anchor's. */
  function parkInsideTheRun(scroller: HTMLElement): HTMLElement {
    // The wheel is the pane being handed to its reader; from here nothing is
    // putting it back.
    fireEvent.wheel(scroller);
    scroller.scrollTop = scroller.scrollHeight - VIEWPORT_PX - 800;
    fireEvent.scroll(scroller);
    flushLayout();
    // Whichever row the run turned out to be, read off the pane rather than
    // named: which messages a row holds is `groups.ts`'s to decide.
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-index]")];
    const run = rows.reduce((most, row) =>
      row.querySelectorAll("[data-msgid]").length > most.querySelectorAll("[data-msgid]").length
        ? row
        : most,
    );
    const index = run.dataset.index;
    scroller.scrollTop = topOf(run) + Math.round(run.offsetHeight / 2);
    fireEvent.scroll(scroller);
    flushLayout();
    // Re-queried, because the element drawing an index before a scroll is not
    // necessarily the one drawing it after.
    return scroller.querySelector<HTMLElement>(`[data-index="${index}"]`)!;
  }

  /**
   * What #609 gave the reader and nothing asserted. A rewrap changes the height
   * of every row at once, and the three kinds are answered by three different
   * things: rows above the fold by the virtualiser, the row the reader is
   * inside by the `grown` branch — the virtualiser declines a row that spans
   * the fold — and rows below by nobody, there being nothing to answer.
   *
   * The reader's own line is what holds, not the row's top: their row grows
   * above them as well as below, and a pane that put the row back would leave
   * them reading a line they had already passed. Which line that is, is the
   * line the fold *cuts through* rather than the first one under it — the two
   * are a different message wherever the reader is parked inside a run.
   *
   * **And it is held by the end of it, which is #613.** The window is cutting
   * that message in half, so a rewrap gives it lines below the fold, between the
   * reader and everything they were reading. Holding its top drew them there:
   * 46px in `webkit2gtk-4.1`, and these tests asserted it.
   */
  it("holds where the line the fold cuts through ends", () => {
    seed(aRunToSitIn(201, 400));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    const run = parkInsideTheRun(scroller);

    // Inside the run and not at the top of it, which is the arrangement rather
    // than an assumption about where the parking landed.
    expect(topOf(run)).toBeLessThan(scroller.scrollTop);
    expect(topOf(run) + run.offsetHeight).toBeGreaterThan(scroller.scrollTop);

    const reading = lineTheFoldCuts(scroller);
    // The window really is cutting it, which is the arrangement the hold below
    // is the answer to rather than a fact about this seed.
    expect(eyeLine(scroller, reading)).toBeLessThan(0);
    const ended = eyeLine(scroller, reading) + linePx(scroller, reading);
    const tall = run.offsetHeight;

    wrapAt(40);
    flushLayout();

    // The rewrap happened, which a test that only asserted the hold could pass
    // without.
    expect(run.offsetHeight).toBeGreaterThan(tall);
    expect(eyeLine(scroller, reading) + linePx(scroller, reading)).toBe(ended);
  });

  /**
   * Which is the hold stated as what the reader sees: the first line they can
   * read whole does not move. It is the line after the one the fold cuts, the
   * two cannot both hold, and this is the one being read.
   */
  it("holds the line after it, which is the first the reader can read", () => {
    seed(aRunToSitIn(201, 400));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    parkInsideTheRun(scroller);

    const reading = lineTheFoldCuts(scroller);
    const next = lineAtTheFold(scroller);
    expect(next).not.toBe(reading);
    const before = eyeLine(scroller, next);
    const started = eyeLine(scroller, reading);

    wrapAt(40);
    flushLayout();

    expect(eyeLine(scroller, next)).toBe(before);
    // And what it costs, which is where the lines the cut message gained went:
    // above the fold, out of a message the window was already cutting.
    expect(eyeLine(scroller, reading)).toBe(started - LINE_PX);
  });

  /**
   * Not a message drawn *at* the fold, which is the arrangement a restore
   * leaves: the reader asked for that message, its first line is the one they
   * are reading, and pushing it up out of the window to hold what is under it
   * would be the same defect the other way round.
   */
  it("holds the top of a message the fold does not cut", () => {
    seed(aRunToSitIn(201, 400));
    render(<Timeline view={TEST_VIEW} />);
    flushLayout();
    const scroller = screen.getByTestId("timeline-scroller");
    parkInsideTheRun(scroller);

    // On the message rather than inside it, which is the whole difference.
    const reading = lineAtTheFold(scroller);
    scroller.scrollTop += eyeLine(scroller, reading);
    fireEvent.scroll(scroller);
    flushLayout();
    expect(eyeLine(scroller, reading)).toBe(0);

    wrapAt(40);
    flushLayout();

    expect(eyeLine(scroller, reading)).toBe(0);
  });
});
