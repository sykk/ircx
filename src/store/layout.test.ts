import { describe, expect, it } from "vitest";
import { SERVER_TARGET } from "@/types";
import {
  EVEN_SPLIT,
  fromStored,
  openStored,
  paneOrder,
  ratioOf,
  removeLeaf,
  setRatio,
  splitLeaf,
  toStored,
} from "./layout";
import type { ChatView, Layout, StoredLayout } from "./types";

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

describe("toStored", () => {
  const views: Record<string, ChatView> = {
    a: { id: "a", network: "libera", target: "#ctf", selectedUser: "syk", raw: false },
    b: { id: "b", network: "libera", target: SERVER_TARGET, selectedUser: null, raw: true },
  };

  it("writes down what each pane holds, and the share between them", () => {
    const tree = setRatio(splitLeaf(leaf("a"), "a", "row", "b"), [], 0.7);

    expect(toStored(tree, views)).toEqual({
      type: "split",
      direction: "row",
      ratio: 0.7,
      children: [
        { type: "view", network: "libera", target: "#ctf", raw: false },
        { type: "view", network: "libera", target: SERVER_TARGET, raw: true },
      ],
    });
  });

  /** `networkRemoved` blanks a view rather than closing its pane, because the
   * layout cannot express a window with nothing in it. There is no conversation
   * to come back to, so nothing is written down for it. */
  it("drops a pane pointed at nothing, collapsing its split", () => {
    const blanked = {
      ...views,
      b: { ...views.b, network: "", target: "" },
    } as Record<string, ChatView>;

    expect(toStored(splitLeaf(leaf("a"), "a", "row", "b"), blanked)).toEqual({
      type: "view",
      network: "libera",
      target: "#ctf",
      raw: false,
    });
  });

  it("has nothing to say about a tree of nothing but blanked panes", () => {
    expect(toStored(leaf("gone"), {})).toBeNull();
  });
});

describe("fromStored", () => {
  const pane = (target: string): StoredLayout => ({
    type: "view",
    network: "libera",
    target,
    raw: false,
  });
  const split = (first: StoredLayout, second: StoredLayout): StoredLayout => ({
    type: "split",
    direction: "row",
    ratio: 0.7,
    children: [first, second],
  });

  const open = (_network: string, target: string) => target === "#ctf" || target === "#test";

  it("keeps the tree, and its share, when every conversation is still open", () => {
    const stored = split(pane("#ctf"), pane("#test"));
    expect(fromStored(stored, open)).toBe(stored);
  });

  it("collapses the split around a conversation that has gone", () => {
    expect(fromStored(split(pane("#ctf"), pane("#closed")), open)).toEqual(pane("#ctf"));
  });

  it("reports a tree with nothing left in it, rather than an empty split", () => {
    expect(fromStored(split(pane("#closed"), pane("#gone")), open)).toBeNull();
  });

  it("keeps the panes either side of one that has gone", () => {
    const stored = split(pane("#ctf"), split(pane("#closed"), pane("#test")));
    expect(fromStored(stored, open)).toEqual(split(pane("#ctf"), pane("#test")));
  });
});

describe("openStored", () => {
  it("opens panes in reading order and hands each one its own id", () => {
    const stored: StoredLayout = {
      type: "split",
      direction: "column",
      ratio: 0.3,
      children: [
        { type: "view", network: "libera", target: "#ctf", raw: false },
        { type: "view", network: "libera", target: SERVER_TARGET, raw: true },
      ],
    };

    const opened: string[] = [];
    const layout = openStored(stored, (view) => {
      opened.push(`${view.target}${view.raw ? " raw" : ""}`);
      return `view-${opened.length}`;
    });

    expect(opened).toEqual(["#ctf", `${SERVER_TARGET} raw`]);
    expect(paneOrder(layout)).toEqual(["view-1", "view-2"]);
    expect(ratioOf(layout)).toBe(0.3);
    expect(layout.type === "split" && layout.direction).toBe("column");
  });
});
