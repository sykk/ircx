import { useAppStore } from "@/store";
import { formatClock } from "./rows";

/** The time a line or a block began, set in the same face and size wherever it
 * appears, and nothing at all for a reader who turned the clock off.
 *
 * Its own module because three things draw it now — the head of a run, a
 * system line, and every message row for a reader who asked for the name on
 * each of them — and the last of those is drawn by a component the block
 * imports. */
export function Clock({ at }: { at: string }) {
  const format = useAppStore((s) => s.presentation.clock);
  const clock = formatClock(at, format);
  if (clock === null) return null;

  return (
    <time
      dateTime={at}
      className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
      style={{ color: "var(--text-faint)" }}
    >
      {clock}
    </time>
  );
}
