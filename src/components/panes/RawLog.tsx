import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useRawLog } from "@/store/selectors";

/**
 * Every line the client and the server exchanged, in order. The store already
 * marks direction and caps the buffer; this is the window onto it.
 */
export function RawLog({ network }: { network: string }) {
  const lines = useRawLog(network);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The tail is the interesting end, but not while the reader has scrolled off
  // it to look at something.
  const following = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
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
        lines.map((line, index) => (
          <div
            key={index}
            className={clsx(
              "break-words whitespace-pre-wrap",
              line.startsWith(">>")
                ? "text-[var(--text-faint)]"
                : "text-[var(--text-secondary)]",
            )}
          >
            {line}
          </div>
        ))
      )}
    </div>
  );
}
