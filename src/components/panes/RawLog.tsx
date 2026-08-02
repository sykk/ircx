import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAppStore } from "@/store";
import { useRawLog } from "@/store/selectors";
import type { ViewId } from "@/store/types";

/** One unwrapped line at 11px on 1.6 leading. Lines that wrap are measured. */
const LINE_HEIGHT = 18;

/** How close to the end still counts as following it. */
const STUCK_PX = 24;

/**
 * Every line the client and the server exchanged, in order. The store already
 * marks direction and caps the buffer; this is the window onto it.
 *
 * Virtualised, because the buffer holds two thousand lines and a `LIST` writes
 * to it faster than a person can read — #119, where drawing every line on every
 * arrival froze the window hard enough to need the process killed. `Timeline`
 * and `MemberList` were already virtualised; this was the list that was not.
 */
export function RawLog({ view, network }: { view: ViewId | null; network: string }) {
  const lines = useRawLog(network);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read once, the way the timeline reads its own: from the restore onwards the
  // scroller owns the position, and a subscription would fight every scroll
  // event with a stale value.
  const restoreTo = useRef(
    view === null ? null : (useAppStore.getState().rawAnchor[view] ?? null),
  );
  // The tail is the interesting end, but not while the reader has scrolled off
  // it to look at something.
  const following = useRef(restoreTo.current === null);

  // Nothing the virtualiser returns leaves this component, so the compiler
  // skipping it costs nothing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 16,
  });

  useEffect(() => {
    const el = scrollRef.current;
    // The sizer carries the whole buffer's height, so this still reaches the
    // end of the log rather than the end of what is drawn.
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Re-asserted every render until it lands, for the reason the timeline's own
  // restore is (#307): a rebuilt pane is measured before it is laid out, so the
  // first attempt often has no room to scroll in, and the virtualiser goes on
  // moving the scroller as it measures lines for real. Once the line is at the
  // top this does nothing, so the loop settles when the measurements do.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const line = restoreTo.current;
    if (line === null || !el || el.clientHeight === 0 || lines.length === 0) return;
    const index = Math.min(line, lines.length - 1);
    const target = virtualizer.getOffsetForIndex(index, "start")?.[0];
    if (target !== undefined && Math.abs(el.scrollTop - target) <= 1) return;
    virtualizer.scrollToIndex(index, { align: "start" });
  });

  /** The reader has taken the pane over, so stop putting it back. */
  const takeOver = useCallback(() => {
    restoreTo.current = null;
  }, []);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Raw protocol log"
      // Anything that moves the scroller by hand, rather than `scroll` itself,
      // which the restore above also raises. The reader has the pane now.
      onWheel={takeOver}
      onPointerDown={takeOver}
      onKeyDown={takeOver}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        // A pane waiting to be put back sits at the top because nothing has
        // moved it yet, not because anybody read their way there — recording
        // that would overwrite the line it is being put back to (#307).
        if (restoreTo.current !== null) return;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < STUCK_PX;
        if (view === null) return;
        // The line at the top of the screen, not the offset it sits at: a
        // rebuilt pane comes back a different width, and a line that wrapped at
        // one width does not at another. Following the tail names no line — it
        // wants whatever is newest, which is what `null` says.
        const top = following.current
          ? null
          : (virtualizer.getVirtualItemForOffset(el.scrollTop)?.index ?? null);
        useAppStore.getState().setRawAnchor(view, top);
      }}
      className="selectable h-full overflow-y-auto px-3 py-2 font-mono text-[11px] leading-[1.6]"
    >
      {lines.length === 0 ? (
        <p className="text-[var(--text-muted)]">Nothing on the wire yet</p>
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = lines[item.index] ?? "";
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={clsx(
                  "absolute top-0 left-0 w-full break-words whitespace-pre-wrap",
                  line.startsWith(">>")
                    ? "text-[var(--text-faint)]"
                    : "text-[var(--text-secondary)]",
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
