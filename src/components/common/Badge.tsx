import clsx from "clsx";

export function Badge({ count, highlight = false }: { count: number; highlight?: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-medium tabular-nums",
        highlight
          ? "bg-[var(--badge-highlight-bg)] text-[var(--badge-highlight-text)]"
          : "bg-[var(--badge-bg)] text-[var(--badge-text)]",
      )}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}
