import { describe, expect, it } from "vitest";
import { EVEN_SPLIT, paneOrder, ratioOf, removeLeaf, setRatio, splitLeaf } from "./layout";
import type { Layout } from "./types";

const leaf = (id: string): Layout => ({ type: "view", id });

describe("splitLeaf", () => {
  it("puts the new pane beside the one that was split", () => {
    expect(splitLeaf(leaf("a"), "a", "row", "b")).toEqual({
      type: "split",
      direction: "row",
      children: [leaf("a"), leaf("b")],
    });
  });

  it("leaves the other panes where they were", () => {
    const before = splitLeaf(leaf("a"), "a", "row", "b");
    const after = splitLeaf(before, "b", "column", "c");

    expect(after).toEqual({
      type: "split",
      direction: "row",
      children: [
        leaf("a"),
        { type: "split", direction: "column", children: [leaf("b"), leaf("c")] },
      ],
    });
    expect(paneOrder(after)).toEqual(["a", "b", "c"]);
  });

  it("returns the same tree for a pane it does not hold", () => {
    const tree = splitLeaf(leaf("a"), "a", "row", "b");
    expect(splitLeaf(tree, "gone", "row", "c")).toBe(tree);
  });
});

describe("removeLeaf", () => {
  it("collapses the split, leaving the sibling in its place", () => {
    const tree = splitLeaf(leaf("a"), "a", "row", "b");
    expect(removeLeaf(tree, "b")).toEqual(leaf("a"));
  });

  it("collapses only the split the pane was in", () => {
    const tree = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");

    expect(removeLeaf(tree, "c")).toEqual({
      type: "split",
      direction: "row",
      children: [leaf("a"), leaf("b")],
    });
  });

  it("reports the last pane going away rather than emptying the tree", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });
});

describe("paneOrder", () => {
  it("reads panes left to right, top to bottom", () => {
    const tree: Layout = {
      type: "split",
      direction: "row",
      children: [
        { type: "split", direction: "column", children: [leaf("a"), leaf("b")] },
        leaf("c"),
      ],
    };
    expect(paneOrder(tree)).toEqual(["a", "b", "c"]);
  });

  it("is empty with no layout", () => {
    expect(paneOrder(null)).toEqual([]);
  });
});

describe("setRatio", () => {
  /** Two panes side by side, the second itself split in two. */
  const nested: Layout = {
    type: "split",
    direction: "row",
    children: [
      leaf("a"),
      { type: "split", direction: "column", children: [leaf("b"), leaf("c")] },
    ],
  };

  it("reads a split with no ratio of its own as an even half", () => {
    expect(ratioOf(splitLeaf(leaf("a"), "a", "row", "b"))).toBe(EVEN_SPLIT);
    expect(ratioOf(leaf("a"))).toBe(EVEN_SPLIT);
  });

  it("moves the split the path names and leaves the others alone", () => {
    const moved = setRatio(nested, [1], 0.7);

    expect(ratioOf(moved)).toBe(EVEN_SPLIT);
    expect(moved.type === "split" && ratioOf(moved.children[1])).toBe(0.7);
  });

  it("moves the root when the path is empty", () => {
    expect(ratioOf(setRatio(nested, [], 0.25))).toBe(0.25);
  });

  it("leaves both sides a pane rather than a sliver", () => {
    expect(ratioOf(setRatio(nested, [], 0))).toBe(0.15);
    expect(ratioOf(setRatio(nested, [], 1))).toBe(0.85);
    expect(ratioOf(setRatio(nested, [], -4))).toBe(0.15);
  });

  it("returns the same tree when nothing moved, so React can skip the render", () => {
    const once = setRatio(nested, [1], 0.7);
    expect(setRatio(once, [1], 0.7)).toBe(once);
    // A path that names no split, and a leaf, both change nothing.
    expect(setRatio(nested, [0], 0.7)).toBe(nested);
    expect(setRatio(leaf("a"), [], 0.7)).toEqual(leaf("a"));
  });

  it("keeps the panes where they were", () => {
    expect(paneOrder(setRatio(nested, [1], 0.8))).toEqual(["a", "b", "c"]);
  });
});
