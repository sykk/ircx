import type { Layout, SplitDirection, ViewId } from "./types";

/** Depth-first left-to-right, which is what `viewOrder` holds. A subtree's
 * views are therefore contiguous in it, so a pane's neighbour in that order is
 * always a pane it shares a split with. */
export function paneOrder(layout: Layout | null): ViewId[] {
  if (!layout) return [];
  if (layout.type === "view") return [layout.id];
  return [...paneOrder(layout.children[0]), ...paneOrder(layout.children[1])];
}

/** Puts `added` beside `id` in its own split, leaving every other pane where it
 * was. Returns the tree unchanged when `id` is not in it. */
export function splitLeaf(
  layout: Layout,
  id: ViewId,
  direction: SplitDirection,
  added: ViewId,
): Layout {
  if (layout.type === "view") {
    if (layout.id !== id) return layout;
    return { type: "split", direction, children: [layout, { type: "view", id: added }] };
  }

  const [first, second] = layout.children;
  const left = splitLeaf(first, id, direction, added);
  if (left !== first) return { ...layout, children: [left, second] };
  const right = splitLeaf(second, id, direction, added);
  if (right !== second) return { ...layout, children: [first, right] };
  return layout;
}

/**
 * A split holds exactly two children, so removing one leaves the other with no
 * sibling to divide from: the split collapses and the survivor takes its place.
 * Without that, closing a pane would leave a divider around a single pane and
 * the next split would nest under an empty one.
 *
 * Returns null when the last pane was removed, which the caller refuses.
 */
export function removeLeaf(layout: Layout, id: ViewId): Layout | null {
  if (layout.type === "view") return layout.id === id ? null : layout;

  const [first, second] = layout.children;
  const left = removeLeaf(first, id);
  if (left === null) return second;
  const right = removeLeaf(second, id);
  if (right === null) return first;
  if (left === first && right === second) return layout;
  return { ...layout, children: [left, right] };
}
