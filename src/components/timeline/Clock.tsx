import { CLOCK_FORMATS } from "@/lib/theme";
import { useAppStore } from "@/store";
import { formatClock } from "./rows";

/** The time a line or a block began, set in the same face and size wherever it
 * appears, and nothing at all for a reader who turned the clock off.
 *
 * Its own module because three things draw it now — the head of a run, a
 * system line, and every message row for a reader who asked for the name on
 * each of them — and the last of those is drawn by a component the block
 * imports. */
export function Clock({ at, column = false }: { at: string; column?: boolean }) {
  const format = useAppStore((s) => s.presentation.clock);
  const clock = formatClock(at, format);
  if (clock === null) return null;

  // Held to the widest the format can print, so the column a leading clock
  // opens is the same width in every block. The unit is the mono face's own
  // character, which is what this element is set in — the block that lines its
  // prose up behind the clock cannot state that width in pixels without
  // knowing which mono face the reader chose.
  const columns = CLOCK_FORMATS.find((candidate) => candidate.id === format)?.columns ?? null;

  return (
    <time
      dateTime={at}
      className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
      style={{
        color: "var(--text-faint)",
        minWidth: column && columns !== null ? `${columns}ch` : undefined,
      }}
    >
      {clock}
    </time>
  );
}
