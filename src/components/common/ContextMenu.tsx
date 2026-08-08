import { useEffect, useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { edgeShift } from "./Tooltip";

export type ContextMenuItem =
  | { kind: "action"; label: string; onClick: () => void; disabled?: boolean }
  | { kind: "separator" };

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface Props {
  menu: ContextMenuState;
  onClose: () => void;
}

/** A menu at the pointer, replacing the webview's own. */
export function ContextMenu({ menu, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const shift = edgeShift(rect, window.innerWidth);
    if (shift !== 0) node.style.transform = `translateX(${shift}px)`;

    const pastBottom = rect.bottom - (window.innerHeight - 8);
    if (pastBottom > 0) node.style.top = `${Math.max(8, menu.y - pastBottom)}px`;
  }, [menu]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (box.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={box}
      role="menu"
      className={clsx(
        "fixed z-[100] min-w-40 rounded-[var(--radius-md)] border border-[var(--border-default)]",
        "bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]",
      )}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item, index) =>
        item.kind === "separator" ? (
          <div
            key={`sep-${index}`}
            role="separator"
            className="my-1 border-t border-[var(--border-subtle)]"
          />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            className={clsx(
              "w-full truncate rounded-[var(--radius-sm)] px-2 py-1 text-left text-[12px]",
              item.disabled
                ? "text-[var(--text-faint)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
