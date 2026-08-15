import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ESTIMATED_ROW_PX, LOAD_OLDER_PX, Timeline } from "./Timeline";
import { makeConversation, makeMessage } from "./fixtures";
import { assignGroups } from "./groups";
import { buildRows } from "./rows";
import { flushLayout, installLayout } from "./layoutHarness";

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
    replyTo: {},
  });
}

function seed(messages: ChatMessage[]) {
  seedTimelines({
    [KEY]: { messages, unreadFrom: null, hasMore: true, loadingOlder: false, askedBehind: null },
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
 * are one block once both are drawn. Run 31 photographed exactly this at lines
 * 0232 and 0233 — the seeder's speaker function repeats where a run happens to
 * straddle wherever the window begins, which is not a shape a walk can arrange.
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
 * The channel run 22 walked, which is not the channel this file's other tests
 * draw. `seed.py` picked its shape to keep `groups.ts` out of the measurement:
 * two people alternating every line, nothing opening with `[` or with `nick:`,
 * three body lengths and the lot sent back to back. So no run is longer than a
 * message, no group is ever assigned, and every row is one line or two.
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
   * measured from the top of the scroller and carry it". End-to-end run 30
   * watched that commit and found the write exact and the reader moved 22 to
   * 46px all the same.
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
   * #535, photographed in end-to-end run 31: the pane that asked was at the top
   * of its content, the page landed with a message by the same person a moment
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

    expect(within(parked).queryByText("Loading older messages")).toBeNull();
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
 * #508's own conditions on #508's own channel. Run 22 measured five landings in
 * eighteen moving a parked pane by exactly one line of text, and this is what
 * it drove: a restored layout with both panes on the channel, the right one
 * wheeled up the archive and then left alone while the left one pages twice.
 *
 * The pane does not move here, and the negative is the useful part. Whatever
 * displaces it in the release app, it is not the head arriving or leaving, not
 * the anchor's placement, not the restore's `scrollToIndex` still reconciling,
 * and not a history rule landing above the reader — all four are in this test
 * and the pane holds through them.
 *
 * What this channel has not got is a row whose height can change after it is
 * drawn. `seed.py` chose that shape deliberately, to keep `groups.ts` out of
 * the measurement, and it keeps out more than it meant to: with no group ever
 * assigned and no run longer than a message, a page landing cannot alter a row
 * that is already on the screen.
 */
describe("the channel run 22 walked", () => {
  const ARCHIVE = Date.parse("2026-07-29T00:00:00.000Z");

  /** The two panes as a restore brings them back, each aimed at the row its
   * reader was left on. */
  function restoredPanes(messages: ChatMessage[]) {
    seed(messages);
    const second = openSecondView();
    const rows = buildRows(
      messages,
      null,
      { nick: "sable", words: [] },
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
    // The wheel is what hands a pane to its reader, and it is how run 22 parked
    // the right one: from here neither is being put back.
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

      reading.scrollTop = 100 + page;
      fireEvent.scroll(reading);
      flushLayout();

      const watching = atTheFold(parked);
      const before = eyeLine(parked, watching);
      land();
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
 * #535 in the pane that did not ask, which end-to-end run 31 could not park a
 * pane for.
 *
 * The band it needs is real and narrow: a pane closer than `LOAD_OLDER_PX` to
 * the top of its content asks for that page itself and is the asker, and a pane
 * further down than the arriving page can reach holds nothing a merge could
 * move. Run 31 tried to aim a wheel burst into it — 700 notches left the pane on
 * line 0253, 750 on 0206, 850 on 0217 — and abandoned the parking on its own
 * evidence.
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
});
