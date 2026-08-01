import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

/** How close to the window edge the box may sit before it is pushed back in. */
const EDGE = 8;

/**
 * How far off centre the box has to move to sit inside the window, given where
 * centring put it. Positive moves it right, negative left. A box wider than the
 * window it is in cannot satisfy both edges, and this answers for the left one,
 * because that is where a line of text starts.
 */
export function edgeShift(
  box: { left: number; right: number },
  windowWidth: number,
): number {
  const past = Math.max(0, box.right - (windowWidth - EDGE));
  const short = Math.max(0, EDGE - box.left);
  if (short > 0) return short;
  return past > 0 ? -past : 0;
}

/**
 * A tooltip is centred on the thing it describes, which works until the label
 * is long or the anchor is near an edge — and in this app it is routinely both.
 * A connected Libera negotiates nineteen capabilities, and the list ran 1404px
 * wide in a 1200px window, cut off mid-word with seven of them unreadable.
 *
 * So the box wraps at a width somebody can read across, and then moves off
 * centre by however much of it is still outside the window. Measuring beats
 * guessing here: the anchors sit in both bottom corners, and which edge is the
 * problem depends on the corner.
 */
export function Tooltip({
  label,
  placement = "bottom",
  children,
}: {
  label: string;
  placement?: "top" | "bottom";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  // The box has to exist before it can be measured, and the answer moves it, so
  // this writes the offset onto the node rather than through a render. It runs
  // before paint, so the untranslated box it measures is never on screen, and
  // centring is done here rather than in a class: Tailwind's own translate
  // utility sets the `translate` property, which a `transform` written here
  // would compose with instead of replace — the box would move twice.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const centred = { left: rect.left - rect.width / 2, right: rect.right - rect.width / 2 };
    node.style.transform = `translateX(calc(-50% + ${edgeShift(centred, window.innerWidth)}px))`;
  }, [open]);

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          ref={box}
          role="tooltip"
          className={clsx(
            "pointer-events-none absolute left-1/2 z-50 w-max max-w-[min(20rem,calc(100vw-1rem))] rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] shadow-[var(--shadow-overlay)]",
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
