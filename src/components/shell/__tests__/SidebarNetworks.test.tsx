import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { SERVER_TARGET } from "@/types";
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

/** The row's ⋮, which is where collapse, the protocol log and the saved
 * settings live. Returns it so a test can assert where focus went. */
function openRowMenu(network: string): HTMLElement {
  const button = screen.getByRole("button", { name: `${network} actions` });
  fireEvent.click(button);
  return button;
}

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

    openRowMenu("Libera.Chat");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide channels" }));

    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "#ctf-ops" })).toBeNull();
    expect(within(group).getByText("7")).toBeTruthy();
    // Queries have their own section, so collapsing a network leaves them be.
    expect(screen.getByRole("treeitem", { name: "phrack" })).toBeTruthy();

    openRowMenu("Libera.Chat");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show channels" }));
    expect(screen.getByRole("treeitem", { name: "#ctf-ops" })).toBeTruthy();
  });

  // #80: the owner could not find the console, the raw log, or the saved
  // password. All three now start from the row a person clicks first.
  describe("the network row", () => {
    beforeEach(() => {
      seedStore(
        [makeNetwork("libera", { name: "Libera.Chat" })],
        [makeChannel("libera", "#ctf-ops")],
      );
    });

    it("opens the network's console, not a collapse", () => {
      render(<SidebarNetworks />);
      const row = screen.getByRole("treeitem", { name: /^Libera\.Chat,/ });

      fireEvent.click(row);

      expect(activeTarget()).toEqual({ network: "libera", target: SERVER_TARGET });
      expect(row.getAttribute("aria-selected")).toBe("true");
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("treeitem", { name: "#ctf-ops" })).toBeTruthy();
    });

    it("opens the console on the protocol log from its menu", () => {
      render(<SidebarNetworks />);

      openRowMenu("Libera.Chat");
      fireEvent.click(screen.getByRole("menuitem", { name: "Raw protocol log" }));

      const { views, activeViewId } = useAppStore.getState();
      expect(activeTarget()).toEqual({ network: "libera", target: SERVER_TARGET });
      expect(views[activeViewId!]?.raw).toBe(true);
    });

    it("opens the network's saved settings from its menu", () => {
      render(<SidebarNetworks />);

      openRowMenu("Libera.Chat");
      fireEvent.click(screen.getByRole("menuitem", { name: "Libera.Chat settings" }));

      expect(useAppStore.getState().setup).toEqual({ network: "libera" });
    });

    it("closes the menu on Escape and gives the button its focus back", () => {
      render(<SidebarNetworks />);
      const button = openRowMenu("Libera.Chat");

      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it("shows one network's menu at a time", () => {
      seedStore([
        makeNetwork("libera", { name: "Libera.Chat" }),
        makeNetwork("oftc", { name: "OFTC" }),
      ]);
      render(<SidebarNetworks />);

      openRowMenu("Libera.Chat");
      openRowMenu("OFTC");

      expect(screen.getAllByRole("menu").map((m) => m.getAttribute("aria-label"))).toEqual([
        "OFTC actions",
      ]);
    });
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
