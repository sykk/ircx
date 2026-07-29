import { useState, type ReactNode } from "react";
import clsx from "clsx";

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
          role="tooltip"
          className={clsx(
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-overlay)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] shadow-[var(--shadow-overlay)]",
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}
