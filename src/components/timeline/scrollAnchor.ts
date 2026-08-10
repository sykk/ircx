import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** The part of the head element this module reads. */
export interface Head {
  readonly offsetHeight: number;
}

/**
 * What the virtualiser is asked. Both answers are in the scroller's own
 * coordinates, the head included, so they compare with `scrollTop` directly.
 */
export interface Offsets {
  /** Where the row holding a message starts, or undefined if it is not there. */
  offsetOfMessage: (id: string) => number | undefined;
  /** A message in the row under an offset, or undefined above the first row. */
  messageAtOffset: (offset: number) => string | undefined;
}

/** Where the reader is: a message, where its row sat under their eyes, and the
 * place it held in the list when that was read. */
interface Anchor {
  id: string;
  delta: number;
  index: number;
}

interface Committed {
  firstId: string | null;
  headPx: number;
}

/**
 * True when the reader's own message is still in the list at a different place
 * in it, which is the whole of what displaces them: something arriving in front
 * of it moves it down, the window dropping its oldest moves it up, and a message
 * arriving behind them moves it not at all.
 *
 * The index it held is checked before the list is searched, so the common case —
 * nothing above the reader changed — is a lookup rather than a scan.
 *
 * Still in the list is what tells a shift from a target switch, which replaces
 * every message and must not be answered by scrolling.
 *
 * Messages rather than rows: a page can merge into the group that was at the
 * top, which changes that row's identity but not any message's.
 */
export function movedInList(
  messages: readonly { id: string }[],
  held: Pick<Anchor, "id" | "index">,
): boolean {
  if (messages[held.index]?.id === held.id) return false;
  return messages.some((message) => message.id === held.id);
}

/**
 * Holds the viewport still when the list changes in front of the reader, and
 * when the head above it comes and goes.
 *
 * Paging history in is the case that built this and it is not the only one: a
 * server that stamps a message behind what is already held sorts it in where it
 * belongs, and the window at its cap drops its oldest to make room. All three
 * put a different amount of list above the reader than they were reading
 * against, which is why the trigger is the reader's own message moving rather
 * than the first one changing.
 *
 * The move is answered by putting that message back where the reader had it,
 * rather than by adding the container's growth to `scrollTop`. The growth is
 * not knowable on this commit and the position is: the DOM at layout time is
 * the render the virtualiser has already superseded — its sizer is still the
 * height estimated for rows that have since been measured, and reading
 * `scrollHeight` corrected for the estimate rather than for the page that
 * landed, by 228px of a 100-message page (#477). The virtualiser's own
 * measurements are current by the time this runs, so its offsets are asked
 * instead, and an offset cannot be wrong about an estimate the way a height
 * difference can.
 *
 * Absolute rather than relative for a second reason. The virtualiser corrects
 * `scrollTop` itself for rows it measures above the fold, in the ref callbacks
 * of this same commit, so by the time a layout effect runs, part of the growth
 * has already been paid for. Anything adding a delta pays it twice; a position
 * subsumes it.
 *
 * Asserted again on the commit after, because the offsets are current on the
 * landing commit and the DOM is not: the rows are still transformed to where
 * the superseded render put them, so the frame that paints is short by whatever
 * was measured between the two. The second pass is what the doubled-estimate
 * control needs — 46px to 92px leaves the landing at 0.0 with it and -102
 * without — and it declines if `scrollTop` is not where the first pass left it,
 * because a reader who scrolled in that window owns the pane and putting them
 * back is the defect rather than the fix.
 *
 * The head is inside the scroller, so it displaces every row below it when it
 * arrives — and it arrives on a commit that changes no message's place, where
 * `movedInList` is false and the growth above the viewport is nobody's business
 * (#475). Its departure needs no term of its own: it leaves on the commit that
 * prepends the page, where the offsets on both sides are measured from the top
 * of the scroller and carry it.
 *
 * Measured off the element rather than taken from the height Timeline keeps in
 * state for the virtualiser's `scrollMargin`: that state is a commit behind the
 * DOM, and this runs on the commit the head lands in.
 *
 * Returns the recorder for the reader's position, which the scroll handler has
 * to call: the page lands a round trip after the scroll that asked for it, so a
 * position recorded on the last commit is however far the reader has read
 * since.
 */
export function usePrependAnchor(
  ref: RefObject<HTMLElement | null>,
  head: RefObject<Head | null>,
  messages: readonly { id: string }[],
  offsets: Offsets,
): () => void {
  const committed = useRef<Committed | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const pending = useRef<(Anchor & { at: number }) | null>(null);
  // Read by `record` between commits, where the rows and messages they close
  // over are the ones last rendered. Nothing changes either without a commit to
  // assign it.
  const latest = useRef(offsets);
  const rendered = useRef(messages);

  const record = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const id = latest.current.messageAtOffset(el.scrollTop);
    const start = id === undefined ? undefined : latest.current.offsetOfMessage(id);
    anchor.current =
      id === undefined || start === undefined
        ? null
        : {
            id,
            delta: start - el.scrollTop,
            index: rendered.current.findIndex((message) => message.id === id),
          };
  }, [ref]);

  useLayoutEffect(() => {
    latest.current = offsets;
    rendered.current = messages;
    const el = ref.current;
    if (!el) return;
    const previous = committed.current;
    const first = messages[0]?.id ?? null;
    const headPx = head.current?.offsetHeight ?? 0;
    const reader = anchor.current;
    if (previous && reader !== null && movedInList(messages, reader)) {
      const start = offsets.offsetOfMessage(reader.id);
      if (start !== undefined) el.scrollTop = start - reader.delta;
      pending.current = { ...reader, at: el.scrollTop };
    } else if (pending.current !== null) {
      const held = pending.current;
      pending.current = null;
      const start = offsets.offsetOfMessage(held.id);
      if (start !== undefined && el.scrollTop === held.at) el.scrollTop = start - held.delta;
    } else if (previous && previous.firstId === first && headPx !== previous.headPx) {
      el.scrollTop = el.scrollTop + (headPx - previous.headPx);
    }
    committed.current = { firstId: first, headPx };
    record();
  });

  return record;
}
