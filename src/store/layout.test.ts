import { describe, expect, it } from "vitest";
import { paneOrder, removeLeaf, splitLeaf } from "./layout";
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
