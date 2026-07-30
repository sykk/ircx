import type { Layout, SplitDirection, ViewId } from "./types";

/** An even split, and what a node with no ratio of its own is worth. */
export const EVEN_SPLIT = 0.5;

/** Smallest share a split will leave either side. A pane narrower than this is
 * a divider with a sliver behind it rather than a conversation; the roster
 * alone is 208px. */
const MIN_SHARE = 0.15;

/** Which child a step in a path names: 0 is the first, 1 is the second. */
export type SplitPath = readonly number[];

export function ratioOf(node: Layout): number {
  return node.type === "split" ? (node.ratio ?? EVEN_SPLIT) : EVEN_SPLIT;
}

/**
 * Sets one split's ratio, addressed by the path taken to reach it from the
 * root. Splits carry no id — they are made and unmade by splitting and closing
 * panes rather than named — so where a split is in the tree is what identifies
 * it, and that is what the component drawing the divider already knows.
 */
export function setRatio(layout: Layout, path: SplitPath, ratio: number): Layout {
  if (layout.type !== "split") return layout;
  if (path.length === 0) {
    const held = Math.min(Math.max(ratio, MIN_SHARE), 1 - MIN_SHARE);
    return held === ratioOf(layout) ? layout : { ...layout, ratio: held };
  }

  const [step, ...rest] = path;
  const child = layout.children[step === 1 ? 1 : 0];
  const changed = setRatio(child, rest, ratio);
  if (changed === child) return layout;
  return {
    ...layout,
    children: step === 1 ? [layout.children[0], changed] : [changed, layout.children[1]],
  };
}

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
