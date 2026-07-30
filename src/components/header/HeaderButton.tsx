import type { ReactNode } from "react";
import clsx from "clsx";

interface HeaderButtonProps {
  label: string;
  title?: string;
  /** A toggle rather than a plain action; also drives the accent colour. */
  pressed?: boolean;
  /** A menu button rather than a plain action; also drives the accent colour. */
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}

export function HeaderButton({
  label,
  title,
  pressed,
  expanded,
  onClick,
  children,
}: HeaderButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      title={title ?? label}
      onClick={onClick}
      className={clsx(
        "rounded-[var(--radius-md)] p-1.5 hover:bg-[var(--surface-hover)]",
        pressed === true || expanded === true
          ? "text-[var(--accent)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
      )}
    >
      {children}
    </button>
  );
}
