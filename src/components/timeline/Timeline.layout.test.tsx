import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { AppState } from "@/store/types";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ESTIMATED_ROW_PX, Timeline } from "./Timeline";
import { makeConversation } from "./fixtures";
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
 * The pane that asked for the page is not the only one the ask reaches:
 * `loadingOlder` is the conversation's rather than the pane's, so the head
 * saying so is drawn in both of them, and the archive lands in both of them.
 * The parked pane sees a page it did not ask for arrive above a reader who is
 * not there.
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

  it("draws the head of a read it did not ask for", () => {
    const { reading, parked } = twoPanes();
    heldOpen(olderPage(11));

    reading.scrollTop = 100;
    fireEvent.scroll(reading);
    flushLayout();

    expect(within(parked).getByText("Loading older messages")).toBeTruthy();
  });

  it("leaves the parked pane's page where it was while that head is up", () => {
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
    // Read with the head up, which is where the reader's eyes were for the
    // whole of the round trip.
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
