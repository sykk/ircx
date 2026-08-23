import { useRef, useState } from "react";
import { useAppStore } from "@/store";
import { ratioOf, type SplitPath } from "@/store/layout";
import type { Layout } from "@/store/types";
import { ChatPane } from "./ChatPane";

/** How far an arrow key moves a divider, as a share of the split. */
const KEY_STEP = 0.02;

/**
 * How narrow a side-by-side pane may be dragged, in pixels.
 *
 * `MIN_SHARE` in the store is a share, and a share cannot say "still wide
 * enough to be a pane" on a window whose width it does not know: 15% of a
 * 1200px window is 147px, and 147px of conversation wraps message text to about
 * a character a line.
 *
 * Browser measurements put the readable floor at 280px. A pane with its roster
 * dropped — which happens below 440px, `ContextPanel` — is all conversation,
 * and 280px is where the text goes back to wrapping at word boundaries. The
 * roster case is not this constant's business precisely because
 * the roster gets out of the way first: these two work together, and a floor
 * big enough to hold a roster as well would be 440 and would leave the divider
 * ±40px of travel on a 1200px window, which is most of a control given up.
 *
 * Side by side only. A pane stacked above another is short rather than narrow,
 * which is its own measurement and nobody has taken it.
 */
const MIN_PANE_PX = 280;

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

  /**
   * The same share with neither side below `MIN_PANE_PX`, which the store's
   * share floor cannot express.
   *
   * Halved rather than refused when the split is too small to give both sides
   * that much: an even split is the best the space allows, and a divider that
   * will not move at all reads as broken. That case starts around a 600px
   * split, which is a window narrower than the app opens at.
   */
  const held = (share: number): number => {
    if (!row) return share;
    const span = self.current?.parentElement?.getBoundingClientRect().width;
    if (!span) return share;
    const floor = Math.min(MIN_PANE_PX / span, 0.5);
    return Math.min(Math.max(share, floor), 1 - floor);
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
        if (share !== null) setSplitRatio(path, held(share));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onKeyDown={(event) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const on = row ? "ArrowRight" : "ArrowDown";
        if (event.key === back) setSplitRatio(path, held(ratio - KEY_STEP));
        else if (event.key === on) setSplitRatio(path, held(ratio + KEY_STEP));
        else return;
        event.preventDefault();
      }}
    >
      {/* Centred in the target rather than along its leading edge, which is
          where it used to be drawn. The four pixels were there to be caught,
          but they all lay on one side of the line: a pointer aimed at the rule
          and landing a pixel short of it hit a pane instead, and there was
          nothing to say why the divider had not moved. Walked in Chrome at
          1200px — 718 and 719 did nothing, 720 dragged. It is ±2px now,
          around what a person is actually aiming at. */}
      <div
        aria-hidden
        className={
          row
            ? "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border-default)]"
            : "pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--border-default)]"
        }
      />
    </div>
  );
}
