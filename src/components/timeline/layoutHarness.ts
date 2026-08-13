import { act } from "@testing-library/react";
import { ESTIMATED_ROW_PX } from "./Timeline";

/**
 * The layout jsdom does not do, modelled well enough for tests about where a
 * pane sits rather than about what it says.
 *
 * `Timeline.test.tsx` stubs every row at exactly `ESTIMATED_ROW_PX`, which is
 * the one case where an offset taken from the estimate cannot be wrong — and
 * #477 and #508 are both about what happens when it is. Rows here measure from
 * what they draw, so they differ from the estimate and from each other, and a
 * row that gains lines gains height.
 *
 * Uneven rows alone are not a model of a browser: they are a model of a browser
 * that has stopped reconciling. The virtualiser measures a row as its element
 * mounts, corrects the scroller for the estimate it had been using, and goes on
 * correcting as rows change under it. Both halves of that need answering here —
 * `scrollTo`, which is how every correction it makes is applied, and a
 * `ResizeObserver` that reports a row whose height changed. Without them uneven
 * rows displace the pane doing the reading, which is the case the live app gets
 * right.
 *
 * Nothing in the render path imports this.
 */

/** What the scroller reports as its viewport. */
export const VIEWPORT_PX = 600;
/** And as its width, which is what the model wraps prose at. */
export const VIEWPORT_WIDTH_PX = 800;
/** A line of text, which is the unit every height here is built from and the
 * displacement #508 measured in the release app. */
export const LINE_PX = 24;
/** The name and the clock over the head of a run: a line of its own, and the
 * one a page merging into that run takes away. */
export const NAME_PX = LINE_PX;
/** A date, an unread seam, the line at the head of the history. */
export const DIVIDER_PX = 24;
/** The history head, at the height it has in the release app. */
export const HISTORY_HEAD_PX = 24;
/** Padding and the gap under a row, so that a row of one line and no name over
 * it measures at exactly the estimate and every other row does not. */
const FRAME_PX = ESTIMATED_ROW_PX - LINE_PX;
/** Where prose wraps. Narrow enough that the fixtures' longer lines take two. */
const CHARS_PER_LINE = 56;

/** How many lines a string takes at this width, newlines included: a fenced
 * block is several lines of one message. */
function wrapped(text: string): number {
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
  }
  return lines;
}

/**
 * A row's height, from the lines it draws.
 *
 * The name over a run is counted by the clock beside it, and only where that
 * clock is the run's rather than a line's: a reader who asked for the name on
 * every line is drawn a clock inside each message instead, where it is part of
 * the line it sits in.
 */
function rowPx(row: HTMLElement): number {
  let lines = 0;
  for (const line of row.querySelectorAll<HTMLElement>("[data-msgid]")) {
    lines += wrapped(line.textContent ?? "");
  }
  const names = [...row.querySelectorAll("time")].filter(
    (clock) => clock.closest("[data-msgid]") === null,
  ).length;
  if (lines === 0 && names === 0) return DIVIDER_PX;
  return lines * LINE_PX + names * NAME_PX + FRAME_PX;
}

function heightOf(el: HTMLElement): number {
  if (el.hasAttribute("data-index")) return rowPx(el);
  if (el.dataset.testid === "timeline-head") return HISTORY_HEAD_PX;
  return VIEWPORT_PX;
}

interface Observation {
  callback: ResizeObserverCallback;
  observer: ResizeObserver;
  /** What each target was last reported as, so only a change is delivered. */
  reported: Map<HTMLElement, number>;
}

const watching = new Set<Observation>();
/** Scrollers moved since the last flush, by whoever moved them. */
const scrolled = new Set<HTMLElement>();
/** Frame callbacks asked for and not yet run. */
const frames = new Map<number, FrameRequestCallback>();

/**
 * Frames, until there is nothing left to draw one for. A frame is what a
 * browser does between one line of a test and the next and jsdom does not: the
 * scroll events owed to scrollers that moved, the callbacks asked for by
 * `requestAnimationFrame`, and the boxes whose size changed.
 *
 * All three matter to a pane's position, and none of them is optional.
 *
 * The scroll event is what tells the virtualiser a pane it did not move is
 * somewhere else, and the anchor moves panes by writing `scrollTop`. Without
 * one it goes on drawing the rows for the offset it last heard about, so a pane
 * put back by the anchor draws the wrong part of the channel.
 *
 * The frame callback is where it reconciles a `scrollToIndex` — the restore and
 * the follow both make one — against measurements that were estimates when the
 * scroll was asked for. It re-asserts the target until the target stops moving,
 * for up to five seconds. A test that never ran a frame left that reconcile
 * outstanding, and it landed on top of whatever the reader did next.
 *
 * A row measured at mount goes through the virtualiser's own ref callback and
 * needs no observer. What needs one is a row that changes height while it is
 * mounted — the case `measureElement` will not re-read, because without an
 * entry to read a size off it answers out of the cache.
 */
export function flushLayout(): void {
  for (let pass = 0; pass < 60; pass++) {
    // In the order the rendering step hands them out.
    const moved = [...scrolled];
    scrolled.clear();
    const due = [...frames.values()];
    frames.clear();
    const rounds = [...watching]
      .map((watch) => ({ watch, entries: changedSince(watch) }))
      .filter((round) => round.entries.length > 0);
    if (rounds.length === 0 && moved.length === 0 && due.length === 0) return;
    act(() => {
      for (const scroller of moved) scroller.dispatchEvent(new Event("scroll"));
      for (const frame of due) frame(pass);
      for (const { watch, entries } of rounds) watch.callback(entries, watch.observer);
    });
  }
  throw new Error("the layout did not settle in 60 frames");
}

function changedSince(watch: Observation): ResizeObserverEntry[] {
  const entries: ResizeObserverEntry[] = [];
  for (const [target, was] of watch.reported) {
    const now = heightOf(target);
    if (now === was) continue;
    watch.reported.set(target, now);
    entries.push({
      target,
      borderBoxSize: [{ blockSize: now, inlineSize: VIEWPORT_WIDTH_PX }],
      contentBoxSize: [{ blockSize: now, inlineSize: VIEWPORT_WIDTH_PX }],
      devicePixelContentBoxSize: [{ blockSize: now, inlineSize: VIEWPORT_WIDTH_PX }],
      contentRect: new DOMRectReadOnly(0, 0, VIEWPORT_WIDTH_PX, now),
    });
  }
  return entries;
}

/**
 * Puts the model in place, for the whole of a test file. Sizes come off the
 * prototype because the elements they belong to are React's to create.
 */
export function installLayout(): void {
  class ModelledResizeObserver implements ResizeObserver {
    private readonly watch: Observation;

    constructor(callback: ResizeObserverCallback) {
      this.watch = { callback, observer: this, reported: new Map() };
      watching.add(this.watch);
    }

    observe(target: Element): void {
      // At the size it already has: a browser reports one on observing, and the
      // virtualiser has just measured this element itself. Reporting a change
      // that did not happen would ask it to correct for a delta of zero.
      this.watch.reported.set(target as HTMLElement, heightOf(target as HTMLElement));
    }

    unobserve(target: Element): void {
      this.watch.reported.delete(target as HTMLElement);
    }

    disconnect(): void {
      this.watch.reported.clear();
      watching.delete(this.watch);
    }
  }
  globalThis.ResizeObserver = ModelledResizeObserver;

  // jsdom runs these off a timer, which puts them at the mercy of whether a
  // test happens to await something. Held instead until the next frame this
  // file draws.
  let nextFrame = 1;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heightOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => VIEWPORT_WIDTH_PX,
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
  // is to scroll.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.querySelector<HTMLElement>('[data-testid="timeline-sizer"]');
      const declared = sizer?.style.height;
      if (!declared) return this.offsetHeight;
      const head = this.querySelector<HTMLElement>('[data-testid="timeline-head"]');
      return Number.parseFloat(declared) + (head === null ? 0 : HISTORY_HEAD_PX);
    },
  });
  // jsdom keeps scrollTop as a plain number and lets anything be written to it.
  // A browser will not scroll past what there is to scroll, and a pane holding
  // less than a screenful cannot be scrolled at all.
  const offsets = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const furthest = Math.max(0, this.scrollHeight - this.clientHeight);
      const to = Math.min(Math.max(0, value), furthest);
      if (to === (offsets.get(this) ?? 0)) return;
      offsets.set(this, to);
      // Owed to whoever is listening, and not paid here: a browser raises this
      // after the layout rather than out of the assignment, and a handler that
      // ran inside one would be running in the middle of the layout effect that
      // moved the pane.
      scrolled.add(this);
    },
  });
  // Every correction the virtualiser makes for a row it has measured is applied
  // through this. jsdom leaves it unimplemented, which reads from the inside as
  // a browser that declines to scroll — the corrections are computed, asked for
  // and dropped.
  HTMLElement.prototype.scrollTo = function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof options === "number") this.scrollTop = y ?? this.scrollTop;
    else this.scrollTop = options?.top ?? this.scrollTop;
  } as HTMLElement["scrollTo"];
}
