import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** The part of a scroll container this module reads and writes. */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
}

/** The part of the head element this module reads. */
export interface Head {
  readonly offsetHeight: number;
}

interface Committed {
  firstId: string | null;
  scrollHeight: number;
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
 * Older rows land above the viewport, so the container grows by exactly the
 * height they occupy and every existing row moves down by that amount. Adding
 * the growth back to scrollTop puts the same pixels under the same eyes.
 *
 * The virtualiser sizes unmeasured rows from its estimate, so the growth here
 * is estimated too. That is still correct for the rows on screen: they were
 * already measured, and the rows the estimate covers are the offscreen ones.
 */
export function anchorScrollTop(scroller: Scroller, heightBefore: number): void {
  const growth = scroller.scrollHeight - heightBefore;
  if (growth <= 0) return;
  scroller.scrollTop = scroller.scrollTop + growth;
}

/**
 * Holds the viewport still when older history is prepended, and when the head
 * above the list comes and goes. Runs on every commit so the recorded height is
 * always the one from before the next change.
 *
 * The head is inside the scroller, so it displaces every row below it when it
 * arrives — and it arrives on a commit that prepends nothing, where `isPrepend`
 * is false and the growth above the viewport is nobody's business (#475). Its
 * departure needs no term of its own: it leaves on the commit that prepends the
 * page, where its height is inside the `scrollHeight` difference on both sides.
 *
 * Measured off the element rather than taken from the height Timeline keeps in
 * state for the virtualiser's `scrollMargin`: that state is a commit behind the
 * DOM, and this runs on the commit the head lands in.
 *
 * Only where the top of the list held still, because a target switch swaps it
 * and the pane is put back to a remembered row rather than held where it was.
 */
export function usePrependAnchor(
  ref: RefObject<HTMLElement | null>,
  head: RefObject<Head | null>,
  messages: readonly { id: string }[],
): void {
  const committed = useRef<Committed | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = committed.current;
    const first = messages[0]?.id ?? null;
    const headPx = head.current?.offsetHeight ?? 0;
    if (previous && isPrepend(previous, messages)) {
      anchorScrollTop(el, previous.scrollHeight);
    } else if (previous && previous.firstId === first && headPx !== previous.headPx) {
      el.scrollTop = el.scrollTop + (headPx - previous.headPx);
    }
    committed.current = { firstId: first, scrollHeight: el.scrollHeight, headPx };
  });
}
