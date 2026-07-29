import { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { anchorScrollTop, isPrepend, usePrependAnchor } from "./scrollAnchor";

function ids(...values: string[]) {
  return values.map((id) => ({ id }));
}

describe("isPrepend", () => {
  it("is true when the old first row moved down the list", () => {
    expect(isPrepend({ firstId: "b", scrollHeight: 100 }, ids("a", "b", "c"))).toBe(true);
  });

  it("is false when nothing changed", () => {
    expect(isPrepend({ firstId: "a", scrollHeight: 100 }, ids("a", "b"))).toBe(false);
  });

  it("is false when messages were only appended", () => {
    expect(isPrepend({ firstId: "a", scrollHeight: 100 }, ids("a", "b", "c"))).toBe(false);
  });

  it("is false for a whole-list swap, which is what a target switch looks like", () => {
    expect(isPrepend({ firstId: "a", scrollHeight: 100 }, ids("x", "y"))).toBe(false);
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

/** Stands in for the virtualiser's sizer: height is whatever the test says. */
function Scroller({ messages, height }: { messages: { id: string }[]; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  usePrependAnchor(ref, messages);
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
});
