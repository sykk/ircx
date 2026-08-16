import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { AppShell } from "../AppShell";
import { makeChannel, makeNetwork, resetStore, seedStore } from "../fixtures";
import { loadViewState } from "../viewState";

function resizeTo(px: number) {
  window.innerWidth = px;
  act(() => void window.dispatchEvent(new Event("resize")));
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
  window.innerWidth = 1200;
});

describe("AppShell", () => {
  it("renders against an empty store", () => {
    render(<AppShell />);
    expect(screen.getByRole("navigation", { name: "Networks" })).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  /** The member list is drawn inside the pane that owns it, so the shell is
   * the sidebar, the conversation and the status bar and nothing else. */
  it("leaves the main column everything the sidebar does not take", () => {
    const { container } = render(<AppShell />);
    const body = container.querySelector("main")!.parentElement!;

    expect(body.style.gridTemplateColumns).toBe("240px 4px minmax(0, 1fr)");
  });

  it("withholds the sidebar on a narrow window", () => {
    render(<AppShell />);

    resizeTo(800);

    expect(screen.queryByRole("navigation", { name: "Networks" })).toBeNull();
  });

  it("brings the sidebar back over the main column on demand when narrow", () => {
    window.innerWidth = 800;
    render(<AppShell />);
    expect(screen.queryByRole("navigation", { name: "Networks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    expect(screen.getByRole("navigation", { name: "Networks" })).toBeTruthy();

    resizeTo(1200);
    expect(screen.getByRole("navigation", { name: "Networks" })).toBeTruthy();
  });

  it("resizes the sidebar from the keyboard within the store's bounds", () => {
    render(<AppShell />);
    const handle = screen.getByRole("separator", { name: "Sidebar width" });

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useAppStore.getState().sidebarWidth).toBe(256);

    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useAppStore.getState().sidebarWidth).toBe(180);
  });

  it("persists sidebar width and collapsed networks", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<AppShell />);

    fireEvent.keyDown(screen.getByRole("separator", { name: "Sidebar width" }), {
      key: "ArrowRight",
    });
    fireEvent.click(screen.getByRole("button", { name: "libera actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide conversations" }));

    expect(loadViewState()).toEqual({
      sidebarWidth: 256,
      rosterWidth: null,
      collapsedNetworks: ["libera"],
      pinnedTargets: [],
      layout: null,
    });
  });

  it("persists pinned conversations", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<AppShell />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "#ctf-ops" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    expect(loadViewState()?.pinnedTargets).toHaveLength(1);
  });

  it("writes the panes down as the conversations they hold", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<AppShell />);

    act(() => {
      useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });
      useAppStore.getState().splitActiveView("row");
      useAppStore.getState().setSplitRatio([], 0.7);
    });

    expect(loadViewState()?.layout).toEqual({
      type: "split",
      direction: "row",
      ratio: 0.7,
      children: [
        { type: "view", network: "libera", target: "#ctf-ops", raw: false },
        { type: "view", network: "libera", target: "#ctf-ops", raw: false },
      ],
    });
  });

  /** Until a pane opens there is nothing to say, and saying it would throw away
   * the layout the run has not restored yet. */
  it("keeps a stored layout while the window is still empty", () => {
    const layout = { type: "view", network: "libera", target: "#ctf-ops", raw: false };
    localStorage.setItem(
      "ircx.shell.view",
      JSON.stringify({ sidebarWidth: 240, collapsedNetworks: [], layout }),
    );
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<AppShell />);

    fireEvent.keyDown(screen.getByRole("separator", { name: "Sidebar width" }), {
      key: "ArrowRight",
    });

    expect(loadViewState()?.layout).toEqual(layout);
  });

  it("restores persisted view state on mount", () => {
    localStorage.setItem(
      "ircx.shell.view",
      JSON.stringify({ sidebarWidth: 320, rosterWidth: 288, collapsedNetworks: ["libera"] }),
    );
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    render(<AppShell />);

    expect(useAppStore.getState().sidebarWidth).toBe(320);
    expect(useAppStore.getState().rosterWidth).toBe(288);
    expect(screen.queryByRole("treeitem", { name: "#ctf-ops" })).toBeNull();
  });

  /** The entries a shipped build already wrote have no roster width in them,
   * and reading one must not hand the column a width nobody chose. */
  it("leaves the member list sizing itself when nothing was stored for it", () => {
    localStorage.setItem(
      "ircx.shell.view",
      JSON.stringify({ sidebarWidth: 320, collapsedNetworks: [] }),
    );
    render(<AppShell />);

    expect(useAppStore.getState().rosterWidth).toBeNull();
  });

  it("ignores a corrupt stored view state", () => {
    localStorage.setItem("ircx.shell.view", "{not json");
    render(<AppShell />);

    expect(useAppStore.getState().sidebarWidth).toBe(240);
  });
});
