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

/** Where the reader is: a message, and where its row sat under their eyes. */
interface Anchor {
  id: string;
  delta: number;
}

interface Committed {
  firstId: string | null;
  headPx: number;
}

/**
 * True when the message that used to be first was pushed down by older ones
 * rather than replaced wholesale. A target switch swaps the whole list and must
 * not be treated as a prepend, so the old first message has to still be there.
 *
 * Messages rather than rows: a prepended page can merge into the group that was
 * at the top, which changes that row's identity but not any message's.
 */
export function isPrepend(
  previous: Pick<Committed, "firstId"> | null,
  messages: readonly { id: string }[],
): boolean {
  if (!previous || previous.firstId === null) return false;
  const first = messages[0]?.id ?? null;
  if (first === previous.firstId) return false;
  return messages.some((message) => message.id === previous.firstId);
}

/**
 * Holds the viewport still when older history is prepended, and when the head
 * above the list comes and goes.
 *
 * A prepend is answered by putting a message back where the reader had it,
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
 * arrives — and it arrives on a commit that prepends nothing, where `isPrepend`
 * is false and the growth above the viewport is nobody's business (#475). Its
 * departure needs no term of its own: it leaves on the commit that prepends the
 * page, where the offsets on both sides are measured from the top of the
 * scroller and carry it.
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
  // Read by `record` between commits, where the rows it closes over are the
  // ones last rendered. Nothing changes them without a commit to assign this.
  const latest = useRef(offsets);

  const record = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const id = latest.current.messageAtOffset(el.scrollTop);
    const start = id === undefined ? undefined : latest.current.offsetOfMessage(id);
    anchor.current =
      id === undefined || start === undefined ? null : { id, delta: start - el.scrollTop };
  }, [ref]);

  useLayoutEffect(() => {
    latest.current = offsets;
    const el = ref.current;
    if (!el) return;
    const previous = committed.current;
    const first = messages[0]?.id ?? null;
    const headPx = head.current?.offsetHeight ?? 0;
    if (previous && isPrepend(previous, messages)) {
      const held = anchor.current;
      const start = held === null ? undefined : offsets.offsetOfMessage(held.id);
      if (held !== null && start !== undefined) el.scrollTop = start - held.delta;
      pending.current = held === null ? null : { ...held, at: el.scrollTop };
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
