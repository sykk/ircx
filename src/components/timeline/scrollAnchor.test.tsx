import { useLayoutEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Head } from "./scrollAnchor";
import { anchorScrollTop, isPrepend, usePrependAnchor } from "./scrollAnchor";

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

describe("anchorScrollTop", () => {
  it("moves down by exactly the height the new content added", () => {
    const scroller = { scrollTop: 900, scrollHeight: 12_000 };
    anchorScrollTop(scroller, 4_000);
    expect(scroller.scrollTop).toBe(8_900);
  });

  it("leaves the position alone when the container did not grow", () => {
    const scroller = { scrollTop: 900, scrollHeight: 4_000 };
    anchorScrollTop(scroller, 4_000);
    expect(scroller.scrollTop).toBe(900);
  });
});

/**
 * Stands in for the virtualiser's sizer: height is whatever the test says, and
 * `head` is the height of the line above it, `null` for a commit it is absent
 * from. The head is an object rather than a rendered element because jsdom lays
 * nothing out and a real one would answer 0 however tall the test drew it.
 *
 * Set in a layout effect declared before the hook, so it holds the height the
 * commit brought by the time the hook reads it — which is where the real head
 * is, being in the DOM before any effect runs.
 */
function Scroller({
  messages,
  height,
  head = null,
}: {
  messages: { id: string }[];
  height: number;
  head?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headRef = useRef<Head | null>(null);
  useLayoutEffect(() => {
    headRef.current = head === null ? null : { offsetHeight: head };
  });
  usePrependAnchor(ref, headRef, messages);
  return (
    <div ref={ref} data-testid="scroller">
      <div style={{ height }} />
    </div>
  );
}

function stubHeight(el: HTMLElement, height: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: height });
}

describe("usePrependAnchor", () => {
  it("holds the viewport over the same rows when history is prepended", () => {
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d", "e")} height={3_000} />);
    const el = getByTestId("scroller");

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("c", "d", "e")} height={3_000} />);
    el.scrollTop = 120;

    stubHeight(el, 9_000);
    rerender(<Scroller messages={ids("a", "b", "c", "d", "e")} height={9_000} />);

    expect(el.scrollTop).toBe(6_120);
  });

  it("does not move on a target switch that happens to grow the list", () => {
    const { getByTestId, rerender } = render(<Scroller messages={ids("c", "d")} height={2_000} />);
    const el = getByTestId("scroller");

    stubHeight(el, 2_000);
    rerender(<Scroller messages={ids("c", "d")} height={2_000} />);
    el.scrollTop = 500;

    stubHeight(el, 9_000);
    rerender(<Scroller messages={ids("x", "y", "z")} height={9_000} />);

    expect(el.scrollTop).toBe(500);
  });

  it("does not move when new messages arrive at the bottom", () => {
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} height={2_000} />);
    const el = getByTestId("scroller");

    stubHeight(el, 2_000);
    rerender(<Scroller messages={ids("a", "b")} height={2_000} />);
    el.scrollTop = 500;

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("a", "b", "c")} height={3_000} />);

    expect(el.scrollTop).toBe(500);
  });

  it("moves down by the head's height when it arrives with nothing prepended", () => {
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} height={3_000} />);
    const el = getByTestId("scroller");

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("a", "b")} height={3_000} />);
    el.scrollTop = 500;

    stubHeight(el, 3_024);
    rerender(<Scroller messages={ids("a", "b")} height={3_024} head={24} />);

    expect(el.scrollTop).toBe(524);
  });

  it("gives the height back when the head leaves with nothing prepended", () => {
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("a", "b")} height={3_024} head={24} />,
    );
    const el = getByTestId("scroller");

    stubHeight(el, 3_024);
    rerender(<Scroller messages={ids("a", "b")} height={3_024} head={24} />);
    el.scrollTop = 524;

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("a", "b")} height={3_000} />);

    expect(el.scrollTop).toBe(500);
  });

  it("counts the head once when it leaves on the commit that prepends", () => {
    const { getByTestId, rerender } = render(
      <Scroller messages={ids("c", "d")} height={3_000} head={24} />,
    );
    const el = getByTestId("scroller");

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("c", "d")} height={3_000} head={24} />);
    el.scrollTop = 120;

    stubHeight(el, 9_000);
    rerender(<Scroller messages={ids("a", "b", "c", "d")} height={9_000} />);

    expect(el.scrollTop).toBe(6_120);
  });

  it("does not correct for the head on a target switch that brings one", () => {
    const { getByTestId, rerender } = render(<Scroller messages={ids("a", "b")} height={3_000} />);
    const el = getByTestId("scroller");

    stubHeight(el, 3_000);
    rerender(<Scroller messages={ids("a", "b")} height={3_000} />);
    el.scrollTop = 500;

    stubHeight(el, 5_024);
    rerender(<Scroller messages={ids("x", "y")} height={5_024} head={24} />);

    expect(el.scrollTop).toBe(500);
  });
});
