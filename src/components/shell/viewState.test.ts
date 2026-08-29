import { beforeEach, describe, expect, it } from "vitest";
import type { StoredLayout } from "@/store/types";
import { targetKey } from "@/store/keys";
import { loadViewState, saveViewState } from "./viewState";

const KEY = "ircx.shell.view";

const split: StoredLayout = {
  type: "split",
  direction: "row",
  ratio: 0.7,
  children: [
    { type: "view", network: "libera", target: "#ctf-ops", raw: false },
    { type: "view", network: "libera", target: "*", raw: true },
  ],
};

beforeEach(() => localStorage.clear());

describe("saving", () => {
  /** The sidebar and the layout are written by different effects at different
   * moments; a whole-entry write would have each undoing the other. */
  it("leaves alone the fields it was not given", () => {
    saveViewState({ sidebarWidth: 320, collapsedNetworks: ["libera"] });
    saveViewState({ layout: split });

    expect(loadViewState()).toEqual({
      sidebarWidth: 320,
      rosterWidth: null,
      collapsedNetworks: ["libera"],
      pinnedNetworks: [],
      pinnedTargets: [],
      layout: split,
    });
  });
});

describe("loading", () => {
  it("reads an entry written before there was a layout to write", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 240, collapsedNetworks: [] }));

    expect(loadViewState()).toEqual({
      sidebarWidth: 240,
      rosterWidth: null,
      collapsedNetworks: [],
      pinnedNetworks: [],
      pinnedTargets: [],
      layout: null,
    });
  });

  it("keeps pinned target keys and drops other values", () => {
    const pinned = targetKey("libera", "#ctf-ops");
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarWidth: 240,
        collapsedNetworks: [],
        pinnedTargets: [pinned, 7, null],
      }),
    );

    expect(loadViewState()?.pinnedTargets).toEqual([pinned]);
  });

  it("keeps pinned network ids and drops other values", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarWidth: 240,
        collapsedNetworks: [],
        pinnedNetworks: ["libera", 7, null],
      }),
    );

    expect(loadViewState()?.pinnedNetworks).toEqual(["libera"]);
  });

  it("drops a layout it cannot read without losing the sidebar with it", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ sidebarWidth: 240, collapsedNetworks: [], layout: "sideways" }),
    );

    expect(loadViewState()).toEqual({
      sidebarWidth: 240,
      rosterWidth: null,
      collapsedNetworks: [],
      pinnedNetworks: [],
      pinnedTargets: [],
      layout: null,
    });
  });

  it("keeps the half of a split it can read", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarWidth: 240,
        collapsedNetworks: [],
        layout: {
          type: "split",
          direction: "row",
          children: [
            { type: "view", network: "libera", target: "#ctf-ops", raw: false },
            { type: "view", network: 7 },
          ],
        },
      }),
    );

    expect(loadViewState()?.layout).toEqual({
      type: "view",
      network: "libera",
      target: "#ctf-ops",
      raw: false,
    });
  });

  it("reads a share no divider could have produced as an even half", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sidebarWidth: 240,
        collapsedNetworks: [],
        layout: { ...split, ratio: 4 },
      }),
    );

    const layout = loadViewState()?.layout;
    expect(layout).not.toHaveProperty("ratio");
    expect(layout).toMatchObject({ type: "split", direction: "row" });
  });

  it("reports nothing at all for an entry that is not an entry", () => {
    localStorage.setItem(KEY, "{oh no");
    expect(loadViewState()).toBeNull();
  });
});
