import { useLayoutEffect, useRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Head, Offsets } from "./scrollAnchor";
import { movedInList, usePrependAnchor } from "./scrollAnchor";

function ids(...values: string[]) {
  return values.map((id) => ({ id }));
}

describe("movedInList", () => {
  it("is true when a page arrived in front of the reader's message", () => {
    expect(movedInList(ids("a", "b", "c"), { id: "b", index: 0 })).toBe(true);
  });

  it("is true when the window dropped its oldest to make room", () => {
    expect(movedInList(ids("b", "c"), { id: "c", index: 2 })).toBe(true);
  });

  it("is false when nothing changed", () => {
    expect(movedInList(ids("a", "b"), { id: "a", index: 0 })).toBe(false);
  });

  it("is false when messages were only appended behind them", () => {
    expect(movedInList(ids("a", "b", "c"), { id: "a", index: 0 })).toBe(false);
  });

  it("is false for a whole-list swap, which is what a target switch looks like", () => {
    expect(movedInList(ids("x", "y"), { id: "a", index: 0 })).toBe(false);
  });
});

/** Where a row sits, in the scroller's own coordinates. */
interface Row {
  /** The message the row is named by, which is the first one in it. */
  id: string;
  start: number;
  size: number;
  /**
   * The run this row draws and how far into it each line is, where the row holds
   * more than the message it is named for. A page landing can merge into the
   * block at the top of the window, and the reader's own message is then drawn
   * that far below where their row starts (#535).
   */
  lines?: { id: string; within: number; px?: number }[];
  /**
   * Whether the virtualiser is still carrying an estimate for this row, so the
   * `scrollTop` it owes for the difference has not been written yet. A row
   * remounted under a new key is in this state for a commit or more, and a block
   * that has just merged a page into itself is remounted by definition.
   */
  unmeasured?: boolean;
}

/** A line of text, which is what a message is until a test says otherwise. Its
 * own height matters only where the message itself grows: everything else here
 * reads the distance between two of them. */
const LINE_PX = 24;

function linesOf(row: Row): { id: string; within: number; px: number }[] {
  const lines = row.lines ?? [{ id: row.id, within: 0 }];
  return lines.map((line) => ({ ...line, px: line.px ?? LINE_PX }));
}

/**
 * Stands in for the virtualiser, and it is the reason these tests can exist at
 * all: the anchor asks where a row is rather than how tall the container has
 * become, so a test can state the answer. jsdom lays nothing out, so a stubbed
 * `scrollHeight` was the only thing the old shape could be told — and the whole
 * of #477 was that the number it read there was the wrong one.
 */
function offsetsFor(layout: Row[]): Offsets {
  const holding = (id: string) => layout.find((row) => linesOf(row).some((l) => l.id === id));
  return {
    offsetOfMessage: (id) => holding(id)?.start,
    messageAtOffset: (offset) => {
      const row = layout.find((r) => offset < r.start + r.size);
      if (row === undefined) return undefined;
      // The last line the offset has reached, which is the message drawn at it
      // rather than the one the row is named for (#608).
      let found = row.id;
      for (const line of linesOf(row)) {
        if (row.start + line.within > offset) break;
        found = line.id;
      }
      return found;
    },
    lineBoxInRow: (id) => {
      const row = holding(id);
      const line = row === undefined ? undefined : linesOf(row).find((l) => l.id === id);
      return line === undefined ? undefined : { top: line.within, bottom: line.within + line.px };
    },
    rowUnmeasured: (id) => holding(id)?.unmeasured ?? false,
  };
}

/**
 * `head` is the height of the line above the list, `null` for a commit it is
 * absent from. An object rather than a rendered element because jsdom would
 * answer 0 however tall the test drew it.
 *
 * Set in a layout effect declared before the hook, so it holds the height the
 * commit brought by the time the hook reads it — which is where the real head
 * is, being in the DOM before any effect runs.
 *
 * `margin` is the head's height as the offsets count it, which is not always
 * the head's height: Timeline hands the virtualiser a `scrollMargin` out of
 * state, so on the commit the head arrives or leaves the two disagree. It
 * defaults to agreeing, which every commit but that one does.
 */
function Scroller({
  messages,
  layout,
  head = null,
  margin = head ?? 0,
}: {
  messages: { id: string }[];
  layout: Row[];
  head?: number | null;
  margin?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headRef = useRef<Head | null>(null);
  useLayoutEffect(() => {
    headRef.current = head === null ? null : { offsetHeight: head };
    // How tall the content is, which jsdom answers 0 for however the test drew
    // it. The anchor compares it against the commit before to tell rows that
    // are still measuring from rows that have finished, so a model that left it
    // at zero would report every landing as settled on the commit after it —
    // which is the shape #532 was.
    //
    // Declared here rather than inside the hook so it runs first, the way the
    // real container's height is a fact before any effect reads it.
    const el = ref.current;
    if (el) {
      const total = layout.reduce((tallest, row) => Math.max(tallest, row.start + row.size), 0);
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: total });
    }
  });
  const { record, release } = usePrependAnchor(
    ref,
    headRef,
    messages,
    offsetsFor(layout),
    margin,
    "pane",
  );
  // `onWheel` as `Timeline` wires it, which is how the reader says the pane is
  // theirs. A bare `scroll` is not that signal: the virtualiser raises one for
  // every correction it makes while a landed page measures.
  return <div ref={ref} data-testid="scroller" onScroll={record} onWheel={release} />;
}

/** The reader taking the pane over, wheel first — which is the order a browser
 * sends them in and the order the app reads them in. */
function readerScrollsTo(el: HTMLElement, top: number) {
  fireEvent.wheel(el);
  scrollTo(el, top);
}

/**
 * jsdom raises nothing for an assignment to `scrollTop`, so the event a browser
 * would send has to be sent by hand. Reading is what the anchor is recorded
 * from, and a test that skipped this would anchor wherever the last commit
 * left the pane.
 */
function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

/** Rows of one height from the top of the scroller down, `head` tall aside. */
function evenly(head: number, size: number, ...values: string[]): Row[] {
  return values.map((id, index) => ({ id, start: head + index * size, size }));
}

describe("usePrependAnchor", () => {
  it("holds the viewport over the same message when history is prepended", () => {
    const before = evenly(0, 1_000, "c", "d", "e");
    const after = evenly(0, 1_000, "a", "b", "c", "d", "e");
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d", "e")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d", "e")} layout={before} />);
    scrollTo(el, 1_200);

    rerender(<Scroller messages={ids("a", "b", "c", "d", "e")} layout={after} />);

    // "d" opened 200px above the fold and is put back 200px above it.
    expect(el.scrollTop).toBe(3_200);
  });

  it("puts the reader back by what the rows measured, not by what they were estimated at", () => {
    const before = evenly(0, 1_000, "c", "d");
    // The two that landed are 1_500 each rather than the 1_000 every row was
    // estimated at, so a shape reading the container's growth is 1_000 short.
    const after: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_500 },
      { id: "c", start: 3_000, size: 1_000 },
      { id: "d", start: 4_000, size: 1_000 },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={after} />);

    expect(el.scrollTop).toBe(3_000);
  });

  /**
   * #535, photographed in end-to-end run 31. The page's last message is by the
   * person whose run the window opens with, so the two sides are drawn as one
   * block: the reader's message opened a row and is now the second line of one.
   * Its row starts 200px higher than the message does, and a pane put back by
   * the row leaves the reader a message lower than they were.
   */
  it("holds the reader still when their row takes in the messages the page brought", () => {
    const before = evenly(0, 1_000, "c", "d");
    const after: Row[] = [
      { id: "a", start: 0, size: 1_000 },
      // "c" kept its own line and lost the row it named: "b" arrived above it,
      // by the same person and a moment earlier, and the block is the two.
      { id: "b", start: 1_000, size: 1_200, lines: [{ id: "b", within: 0 }, { id: "c", within: 200 }] },
      { id: "d", start: 2_200, size: 1_000 },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={after} />);

    // "c" was drawn at the top of the scroller and is put back there: its row
    // starts at 1_000 and its own line is 200 into it.
    expect(el.scrollTop).toBe(1_200);
  });

  /**
   * #608, and the one of its three ways in that nothing else in the app is
   * watching: no page, no fill, no message changing place. A line already drawn
   * above the reader gets taller — a delivery failure gaining its reason, a
   * preview, an edit — and the row's own top does not move, so the reader is
   * carried down by exactly what it gained.
   */
  it("puts the reader back when a line above theirs grows inside their row", () => {
    const before: Row[] = [
      { id: "a", start: 0, size: 1_000 },
      { id: "b", start: 1_000, size: 1_200, lines: [{ id: "b", within: 0 }, { id: "c", within: 200 }] },
    ];
    // "b" is a hundred pixels longer than it was, and "c" is that much further
    // into the row it shares with it. Nothing arrived and nothing moved.
    const grown: Row[] = [
      { id: "a", start: 0, size: 1_000 },
      { id: "b", start: 1_000, size: 1_300, lines: [{ id: "b", within: 0 }, { id: "c", within: 300 }] },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b", "c")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("a", "b", "c")} layout={before} />);
    // The reader is inside that row, on "c" rather than on the "b" its row is
    // named for, which is the arrangement the whole issue is about.
    scrollTo(el, 1_200);

    rerender(<Scroller messages={ids("a", "b", "c")} layout={grown} />);

    expect(el.scrollTop).toBe(1_300);
  });

  it("asserts the place again when the next commit measures the page differently", () => {
    const before = evenly(0, 1_000, "c", "d");
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    // What the rows measured, arriving the commit after they landed.
    const settled: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_500 },
      { id: "c", start: 3_000, size: 1_000 },
      { id: "d", start: 4_000, size: 1_000 },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    expect(el.scrollTop).toBe(2_000);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={settled} />);
    expect(el.scrollTop).toBe(3_000);
  });

  /**
   * #532. The page lands and the rows above the reader are measured over the
   * commits that follow — fourteen of them in end-to-end run 30, two to three
   * milliseconds apart, inside a single frame. The assertion above answers the
   * first of those and the anchor then stood down, so everything measured after
   * it moved the reader: 22 to 46px in the release app, in the pane that asked
   * for the page.
   *
   * Two rows measuring on two separate commits is the smallest version of that,
   * and it is the same shape: the reader is put back on the first and left
   * behind on the second.
   */
  it("goes on asserting it while the rows above the reader are still measuring", () => {
    const before = evenly(0, 1_000, "c", "d");
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    // "a" measures taller than the estimate on the commit after the landing.
    const oneMeasured: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_000 },
      { id: "c", start: 2_500, size: 1_000 },
      { id: "d", start: 3_500, size: 1_000 },
    ];
    // And "b" on the commit after that, which is the one nothing answered.
    const bothMeasured: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_500 },
      { id: "c", start: 3_000, size: 1_000 },
      { id: "d", start: 4_000, size: 1_000 },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    expect(el.scrollTop).toBe(2_000);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={oneMeasured} />);
    expect(el.scrollTop).toBe(2_500);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={bothMeasured} />);
    expect(el.scrollTop).toBe(3_000);
  });

  /**
   * The shape #532 actually had, and the reason a hold cannot let go the first
   * time the pane looks right. In the release app the reader was exactly in
   * place on eleven of the fourteen commits a landing settled over — the rows
   * being measured were below them, so nothing needed correcting — and the
   * twelfth measured a row above them and moved them 11px.
   *
   * A hold that ends when the position is right ends on the first of those and
   * is not there for the twelfth.
   */
  it("keeps the hold through commits that need no correction", () => {
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    // A row below the reader measures taller. "c" has not moved, so this commit
    // asks nothing of the anchor — and the container is still growing.
    const belowGrew: Row[] = [
      { id: "a", start: 0, size: 1_000 },
      { id: "b", start: 1_000, size: 1_000 },
      { id: "c", start: 2_000, size: 1_000 },
      { id: "d", start: 3_000, size: 1_500 },
    ];
    // And then one above them does, which is the commit that moved the reader.
    const aboveGrew: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_000 },
      { id: "c", start: 2_500, size: 1_000 },
      { id: "d", start: 3_500, size: 1_500 },
    ];
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("c", "d")} layout={evenly(0, 1_000, "c", "d")} />,
    );
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={evenly(0, 1_000, "c", "d")} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    expect(el.scrollTop).toBe(2_000);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={belowGrew} />);
    expect(el.scrollTop).toBe(2_000);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={aboveGrew} />);
    expect(el.scrollTop).toBe(2_500);
  });

  it("stops asserting it once the measurements have stopped moving", () => {
    const before = evenly(0, 1_000, "c", "d");
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    expect(el.scrollTop).toBe(2_000);

    // Nothing measured differently, so the hold is spent and the reader owns the
    // pane again: a scroll on the commit after is theirs and stays.
    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    scrollTo(el, 400);
    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);

    expect(el.scrollTop).toBe(400);
  });

  /**
   * A height that stands still is not the measuring being over: the row the
   * reader is inside can be one the virtualiser has yet to measure, and its
   * correction is written a commit or more later.
   *
   * That row is the one a landing page merges into. It is remounted under the key
   * of the message the page brought, so nothing has measured it, and a first
   * measurement is compensated for in full wherever the row *starts* above the
   * fold — the part of it drawn below the reader's line included. So the reader
   * is dropped by everything the page added above them, on a commit the hold used
   * to have ended on.
   */
  it("keeps the hold while the row the reader is inside has yet to be measured", () => {
    const before = evenly(0, 1_000, "c", "d");
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    const pending = landed.map((row) => (row.id === "c" ? { ...row, unmeasured: true } : row));
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={pending} />);
    expect(el.scrollTop).toBe(2_000);

    // Nothing measured differently on this commit, and the hold does not end on
    // it: what the reader's own row owes has not been paid yet.
    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={pending} />);
    // Paid, and by the whole of the row rather than by the part above the fold.
    scrollTo(el, 2_744);
    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);

    expect(el.scrollTop).toBe(2_000);
  });

  it("declines the second assertion once the reader has scrolled away from it", () => {
    const before = evenly(0, 1_000, "c", "d");
    const landed = evenly(0, 1_000, "a", "b", "c", "d");
    const settled: Row[] = [
      { id: "a", start: 0, size: 1_500 },
      { id: "b", start: 1_500, size: 1_500 },
      { id: "c", start: 3_000, size: 1_000 },
      { id: "d", start: 4_000, size: 1_000 },
    ];
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 0);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} />);
    // By hand, which is what tells this from the virtualiser moving the pane
    // while the page it just landed is still being measured (#532).
    readerScrollsTo(el, 500);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={settled} />);

    expect(el.scrollTop).toBe(500);
  });

  it("does not move on a target switch that happens to grow the list", () => {
    const before = evenly(0, 1_000, "c", "d");
    const after = evenly(0, 1_000, "x", "y", "z");
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} />);
    scrollTo(el, 500);

    rerender(<Scroller messages={ids("x", "y", "z")} layout={after} />);

    expect(el.scrollTop).toBe(500);
  });

  it("does not move when new messages arrive at the bottom", () => {
    const before = evenly(0, 1_000, "a", "b");
    const after = evenly(0, 1_000, "a", "b", "c");
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("a", "b")} layout={before} />);
    scrollTo(el, 500);

    rerender(<Scroller messages={ids("a", "b", "c")} layout={after} />);

    expect(el.scrollTop).toBe(500);
  });

  it("moves down by the head's height when it arrives with nothing prepended", () => {
    const before = evenly(0, 1_000, "a", "b");
    const after = evenly(24, 1_000, "a", "b");
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("a", "b")} layout={before} />);
    scrollTo(el, 500);

    rerender(<Scroller messages={ids("a", "b")} layout={after} head={24} />);

    expect(el.scrollTop).toBe(524);
  });

  it("gives the height back when the head leaves with nothing prepended", () => {
    const before = evenly(24, 1_000, "a", "b");
    const after = evenly(0, 1_000, "a", "b");
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("a", "b")} layout={before} head={24} />,
    );
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("a", "b")} layout={before} head={24} />);
    scrollTo(el, 524);

    rerender(<Scroller messages={ids("a", "b")} layout={after} />);

    expect(el.scrollTop).toBe(500);
  });

  /**
   * #508, and the shape of it is the whole finding. On the commit a page lands
   * in, the head the read put up is already out of the DOM and the offsets are
   * still measured as though it were there: the margin they carry is Timeline's
   * `headPx`, which is state, and reaches the virtualiser a commit later.
   *
   * This test asserted the opposite until it was measured — `after` was the
   * offsets already caught up, which is a commit the app does not have. Both
   * halves are here now, the landing and the one behind it, because a pane put
   * wrong by the first and right by the second reads as still from the outside
   * and is what nine live runs found five times in eighteen.
   */
  it("counts the head once when it leaves on the commit that prepends", () => {
    const before = evenly(24, 1_000, "c", "d");
    // The head has gone from the DOM. The offsets still count the margin it
    // held, so every row is answered 24px lower than it is drawn.
    const landed = evenly(24, 1_000, "a", "b", "c", "d");
    // And the commit after, where the margin has caught up with the DOM.
    const settled = evenly(0, 1_000, "a", "b", "c", "d");
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("c", "d")} layout={before} head={24} margin={24} />,
    );
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} head={24} margin={24} />);
    scrollTo(el, 1_224);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={landed} margin={24} />);

    // "d" opened 200px above the fold and is drawn at 3_000, the head's 24px
    // having left the list above it.
    expect(el.scrollTop).toBe(3_200);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={settled} margin={0} />);

    expect(el.scrollTop).toBe(3_200);
  });

  it("does not correct for the head on a target switch that brings one", () => {
    const before = evenly(0, 1_000, "a", "b");
    const after = evenly(24, 1_000, "x", "y");
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} layout={before} />);
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("a", "b")} layout={before} />);
    scrollTo(el, 500);

    rerender(<Scroller messages={ids("x", "y")} layout={after} head={24} />);

    expect(el.scrollTop).toBe(500);
  });
});
