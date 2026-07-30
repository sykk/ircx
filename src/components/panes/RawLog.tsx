import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRawLog } from "@/store/selectors";

/** One unwrapped line at 11px on 1.6 leading. Lines that wrap are measured. */
const LINE_HEIGHT = 18;

/**
 * Every line the client and the server exchanged, in order. The store already
 * marks direction and caps the buffer; this is the window onto it.
 *
 * Virtualised, because the buffer holds two thousand lines and a `LIST` writes
 * to it faster than a person can read — #119, where drawing every line on every
 * arrival froze the window hard enough to need the process killed. `Timeline`
 * and `MemberList` were already virtualised; this was the list that was not.
 */
export function RawLog({ network }: { network: string }) {
  const lines = useRawLog(network);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The tail is the interesting end, but not while the reader has scrolled off
  // it to look at something.
  const following = useRef(true);

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

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Raw protocol log"
      onScroll={() => {
        const el = scrollRef.current;
        if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
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
