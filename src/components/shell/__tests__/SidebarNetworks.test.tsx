import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { SidebarNetworks } from "../SidebarNetworks";
import {
  activeTarget,
  makeChannel,
  makeNetwork,
  makeQuery,
  resetStore,
  seedMockupWorkspace,
  seedStore,
} from "../fixtures";

beforeEach(resetStore);

describe("SidebarNetworks", () => {
  it("tells the user there is nothing configured yet", () => {
    render(<SidebarNetworks />);
    expect(screen.getByText("No networks configured.")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("opens network setup from the + beside the section label", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    fireEvent.click(screen.getByRole("button", { name: "Add a network" }));
    expect(useAppStore.getState().setup).toEqual({ network: null });
  });

  it("offers the + even with nothing configured yet", () => {
    render(<SidebarNetworks />);
    expect(screen.getByRole("button", { name: "Add a network" })).toBeTruthy();
  });

  it("renders one group per network with its channels", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    expect(screen.getByRole("treeitem", { name: /^Libera\.Chat,/ })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#ctf-ops" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#linux" })).toBeTruthy();
  });

  it("gathers every network's queries into one section at the bottom", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    const queries = screen.getByRole("tree", { name: "Queries" });
    expect(
      within(queries)
        .getAllByRole("treeitem")
        .map((row) => row.textContent),
    ).toEqual(["phrack2", "guest", "nyx"]);

    const networks = screen.getByRole("tree", { name: "Networks and channels" });
    expect(within(networks).queryByRole("treeitem", { name: "phrack" })).toBeNull();
  });

  it("draws no queries section when nobody has an open conversation", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<SidebarNetworks />);
    expect(screen.queryByRole("tree", { name: "Queries" })).toBeNull();
  });

  it("keeps the network order the store gives it", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    const groups = within(screen.getByRole("tree", { name: "Networks and channels" }))
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("aria-level") === "1")
      .map((row) => row.textContent);
    expect(groups).toEqual(["Libera.Chat", "OFTC", "Rizon"]);
  });

  it("collapsing hides the group's channels and surfaces their unread total", () => {
    seedStore(
      [makeNetwork("libera", { name: "Libera.Chat" })],
      [
        makeChannel("libera", "#ctf-ops", { unread: 4 }),
        makeChannel("libera", "#hackint", { unread: 3 }),
      ],
      [makeQuery("libera", "phrack", { unread: 2 })],
    );
    render(<SidebarNetworks />);

    const group = screen.getByRole("treeitem", { name: /^Libera\.Chat,/ });
    expect(group.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(group);

    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "#ctf-ops" })).toBeNull();
    expect(within(group).getByText("7")).toBeTruthy();
    // Queries have their own section, so collapsing a network leaves them be.
    expect(screen.getByRole("treeitem", { name: "phrack" })).toBeTruthy();
  });

  it("marks unread with the muted badge and highlights with the highlight badge", () => {
    seedStore(
      [makeNetwork("libera")],
      [
        makeChannel("libera", "#quiet", { unread: 6 }),
        makeChannel("libera", "#loud", { unread: 36, highlights: 2 }),
      ],
    );
    render(<SidebarNetworks />);

    const quiet = within(screen.getByRole("treeitem", { name: "#quiet" })).getByText("6");
    const loud = within(screen.getByRole("treeitem", { name: "#loud" })).getByText("36");

    expect(quiet.className).toContain("bg-[var(--badge-bg)]");
    expect(loud.className).toContain("bg-[var(--badge-highlight-bg)]");
  });

  it("marks keyed and secret channels as restricted, public ones not", () => {
    seedStore(
      [makeNetwork("libera")],
      [
        makeChannel("libera", "#open"),
        makeChannel("libera", "#keyed", { modes: "+ntk hunter2" }),
        makeChannel("libera", "#secret", { modes: "+nts" }),
      ],
    );
    render(<SidebarNetworks />);

    expect(screen.getByRole("treeitem", { name: "#keyed, restricted" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#secret, restricted" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#open" })).toBeTruthy();
  });

  it("a channel key containing a mode letter does not make the channel restricted", () => {
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#open", { modes: "+nt keys" })],
    );
    render(<SidebarNetworks />);

    expect(screen.getByRole("treeitem", { name: "#open" })).toBeTruthy();
  });

  it("selects a target on click and marks the row", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<SidebarNetworks />);

    const row = screen.getByRole("treeitem", { name: "#ctf-ops" });
    fireEvent.click(row);

    expect(activeTarget()).toEqual({
      network: "libera",
      target: "#ctf-ops",
    });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  describe("keyboard navigation", () => {
    beforeEach(() => {
      seedStore(
        [makeNetwork("libera", { name: "Libera.Chat" }), makeNetwork("oftc", { name: "OFTC" })],
        [makeChannel("libera", "#ctf-ops"), makeChannel("libera", "#hackint")],
      );
    });

    it("moves through the visible rows with the arrow keys", () => {
      render(<SidebarNetworks />);
      const group = screen.getByRole("treeitem", { name: /^Libera\.Chat,/ });

      expect(group.getAttribute("tabindex")).toBe("0");
      act(() => group.focus());

      fireEvent.keyDown(group, { key: "ArrowDown" });
      expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "#ctf-ops" }));

      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "#hackint" }));

      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "#ctf-ops" }));

      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /^OFTC,/ }));
    });

    it("collapses and expands a group with the left and right arrows", () => {
      render(<SidebarNetworks />);
      const group = screen.getByRole("treeitem", { name: /^Libera\.Chat,/ });
      act(() => group.focus());

      fireEvent.keyDown(group, { key: "ArrowLeft" });
      expect(group.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "#ctf-ops" })).toBeNull();

      fireEvent.keyDown(group, { key: "ArrowRight" });
      expect(group.getAttribute("aria-expanded")).toBe("true");
    });

    it("left arrow on a channel returns to its network row", () => {
      render(<SidebarNetworks />);
      const channel = screen.getByRole("treeitem", { name: "#hackint" });
      act(() => channel.focus());

      fireEvent.keyDown(channel, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(
        screen.getByRole("treeitem", { name: /^Libera\.Chat,/ }),
      );
    });
  });
});
