import { useRef, useState } from "react";
import { useAppStore } from "@/store";
import { ratioOf, type SplitPath } from "@/store/layout";
import type { Layout } from "@/store/types";
import { ChatPane } from "./ChatPane";

/** How far an arrow key moves a divider, as a share of the split. */
const KEY_STEP = 0.02;

export function PaneTree() {
  const layout = useAppStore((s) => s.layout);
  if (!layout) return <ChatPane view={null} />;
  return <PaneNode node={layout} path={[]} />;
}

/** `path` is the route from the root to this node: each step says which child
 * was taken. A split has no id, so this is how one is named. */
function PaneNode({ node, path }: { node: Layout; path: SplitPath }) {
  if (node.type === "view") return <ChatPane view={node.id} />;

  const row = node.direction === "row";
  const ratio = ratioOf(node);

  return (
    <div className={row ? "flex h-full min-h-0 min-w-0" : "flex h-full min-h-0 min-w-0 flex-col"}>
      {/* Basis zero and a proportional grow, so the two shares divide whatever
          the parent gives this split rather than any fixed width. */}
      <div className="min-h-0 min-w-0" style={{ flex: `${ratio} 1 0` }}>
        <PaneNode node={node.children[0]} path={[...path, 0]} />
      </div>

      <Divider row={row} path={path} ratio={ratio} />

      <div className="min-h-0 min-w-0" style={{ flex: `${1 - ratio} 1 0` }}>
        <PaneNode node={node.children[1]} path={[...path, 1]} />
      </div>
    </div>
  );
}

/**
 * The line between two panes, and the handle that moves it. Wider than the rule
 * it draws: a one-pixel target is not one anybody can hit, so the hit area is
 * padded and the pixel is drawn inside it.
 */
function Divider({ row, path, ratio }: { row: boolean; path: SplitPath; ratio: number }) {
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const [dragging, setDragging] = useState(false);
  const self = useRef<HTMLDivElement>(null);

  /** Where the pointer is within the split, as a share of it. Measured off the
   * parent rather than remembered from the drag's start, so a resize of the
   * window mid-drag cannot leave the divider chasing a stale figure. */
  const shareAt = (clientX: number, clientY: number): number | null => {
    const split = self.current?.parentElement?.getBoundingClientRect();
    if (!split) return null;
    const span = row ? split.width : split.height;
    if (span === 0) return null;
    return row ? (clientX - split.left) / span : (clientY - split.top) / span;
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "Pane width" : "Pane height"}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      tabIndex={0}
      className={
        row
          ? "relative w-1 shrink-0 cursor-col-resize hover:bg-[var(--accent-muted)]"
          : "relative h-1 shrink-0 cursor-row-resize hover:bg-[var(--accent-muted)]"
      }
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const share = shareAt(event.clientX, event.clientY);
        if (share !== null) setSplitRatio(path, share);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onKeyDown={(event) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const on = row ? "ArrowRight" : "ArrowDown";
        if (event.key === back) setSplitRatio(path, ratio - KEY_STEP);
        else if (event.key === on) setSplitRatio(path, ratio + KEY_STEP);
        else return;
        event.preventDefault();
      }}
    >
      <div
        aria-hidden
        className={
          row
            ? "pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--border-default)]"
            : "pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--border-default)]"
        }
      />
    </div>
  );
}
