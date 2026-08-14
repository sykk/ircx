import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ESTIMATED_ROW_PX, Timeline } from "./Timeline";
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
    [KEY]: { messages, unreadFrom: null, hasMore: true, loadingOlder: false, askedBehind: null, historyLanded: 0 },
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

/** How far below the top of the viewport a message is drawn. Rows are laid out
 * inside the sizer, which starts below the head, so the head has to be added
 * back before `scrollTop` can be taken off. */
function eyeLine(scroller: HTMLElement, msgid: string): number {
  const row = scroller
    .querySelector(`[data-msgid="${msgid}"]`)
    ?.closest<HTMLElement>("[data-index]");
  if (!row) throw new Error(`${msgid} is not drawn in this pane`);
  const head = scroller.querySelector<HTMLElement>('[data-testid="timeline-head"]');
  return topOf(row) + (head?.offsetHeight ?? 0) - scroller.scrollTop;
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
