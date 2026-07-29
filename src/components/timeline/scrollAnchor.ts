import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** The part of a scroll container this module reads and writes. */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
}

interface Committed {
  firstId: string | null;
  scrollHeight: number;
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
  previous: Committed | null,
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
 * Holds the viewport still when older history is prepended. Runs on every
 * commit so the recorded height is always the one from before the next change.
 */
export function usePrependAnchor(
  ref: RefObject<HTMLElement | null>,
  messages: readonly { id: string }[],
): void {
  const committed = useRef<Committed | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = committed.current;
    if (previous && isPrepend(previous, messages)) {
      anchorScrollTop(el, previous.scrollHeight);
    }
    committed.current = { firstId: messages[0]?.id ?? null, scrollHeight: el.scrollHeight };
  });
}
