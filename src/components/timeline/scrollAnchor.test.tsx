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

/** Where each message's row sits, in the scroller's own coordinates. */
interface Row {
  id: string;
  start: number;
  size: number;
}

/**
 * Stands in for the virtualiser, and it is the reason these tests can exist at
 * all: the anchor asks where a row is rather than how tall the container has
 * become, so a test can state the answer. jsdom lays nothing out, so a stubbed
 * `scrollHeight` was the only thing the old shape could be told — and the whole
 * of #477 was that the number it read there was the wrong one.
 */
function offsetsFor(layout: Row[]): Offsets {
  return {
    offsetOfMessage: (id) => layout.find((row) => row.id === id)?.start,
    messageAtOffset: (offset) => layout.find((row) => offset < row.start + row.size)?.id,
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
  });
  const record = usePrependAnchor(ref, headRef, messages, offsetsFor(layout), margin);
  return <div ref={ref} data-testid="scroller" onScroll={record} />;
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
    scrollTo(el, 500);

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
