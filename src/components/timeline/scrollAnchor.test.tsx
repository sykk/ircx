import { useLayoutEffect, useRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Head, Offsets } from "./scrollAnchor";
import { isPrepend, usePrependAnchor } from "./scrollAnchor";

function ids(...values: string[]) {
  return values.map((id) => ({ id }));
}

describe("isPrepend", () => {
  it("is true when the old first row moved down the list", () => {
    expect(isPrepend({ firstId: "b" }, ids("a", "b", "c"))).toBe(true);
  });

  it("is false when nothing changed", () => {
    expect(isPrepend({ firstId: "a" }, ids("a", "b"))).toBe(false);
  });

  it("is false when messages were only appended", () => {
    expect(isPrepend({ firstId: "a" }, ids("a", "b", "c"))).toBe(false);
  });

  it("is false for a whole-list swap, which is what a target switch looks like", () => {
    expect(isPrepend({ firstId: "a" }, ids("x", "y"))).toBe(false);
  });

  it("is false on the first commit", () => {
    expect(isPrepend(null, ids("a"))).toBe(false);
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
 */
function Scroller({
  messages,
  layout,
  head = null,
}: {
  messages: { id: string }[];
  layout: Row[];
  head?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headRef = useRef<Head | null>(null);
  useLayoutEffect(() => {
    headRef.current = head === null ? null : { offsetHeight: head };
  });
  const record = usePrependAnchor(ref, headRef, messages, offsetsFor(layout));
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

  it("counts the head once when it leaves on the commit that prepends", () => {
    const before = evenly(24, 1_000, "c", "d");
    // The head has gone, so every row starts 24px higher than it would have.
    const after = evenly(0, 1_000, "a", "b", "c", "d");
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("c", "d")} layout={before} head={24} />,
    );
    const el = getByTestId("scroller");

    rerender(<Scroller messages={ids("c", "d")} layout={before} head={24} />);
    scrollTo(el, 1_224);

    rerender(<Scroller messages={ids("a", "b", "c", "d")} layout={after} />);

    // "d" opened 200px above the fold, and the head's 24px is inside the
    // offsets on both sides rather than a term of its own.
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
