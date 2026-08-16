import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { SERVER_TARGET, type Network } from "@/types";
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

/* Closing reaches the backend, which answers by removing the conversation. The
 * mock stands in for the command; what the tests assert is what the sidebar
 * does, not that it was called. */
vi.mock("@/lib/ipc", () => ({
  ipc: {
    closeTarget: vi.fn().mockResolvedValue(undefined),
    connectNetwork: vi.fn().mockResolvedValue(undefined),
    disconnectNetwork: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
  },
  onIrcxEvent: vi.fn(),
}));

beforeEach(() => {
  resetStore();
  vi.mocked(ipc.closeTarget).mockClear();
  vi.mocked(ipc.connectNetwork).mockReset().mockResolvedValue(undefined);
  vi.mocked(ipc.disconnectNetwork).mockReset().mockResolvedValue(undefined);
  vi.mocked(ipc.removeNetwork).mockClear();
});

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

  it("uses shorter rows only when compact mode is on", () => {
    seedMockupWorkspace();
    const { rerender } = render(<SidebarNetworks />);
    const channel = () => screen.getByRole("treeitem", { name: "#ctf-ops" });

    expect(channel().classList.contains("h-7")).toBe(true);

    act(() => useAppStore.getState().setSidebarCompact(true));
    rerender(<SidebarNetworks />);

    expect(channel().classList.contains("h-6")).toBe(true);
  });

  /* Two networks can both host a NickServ. Gathered into one section those two
   * rows read the same; inside their own network's panel neither is ambiguous. */
  it("puts each network's queries in that network's panel", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    const libera = within(screen.getByRole("group", { name: "Libera.Chat" }));
    expect(libera.getByRole("treeitem", { name: "phrack" })).toBeTruthy();
    expect(libera.queryByRole("treeitem", { name: "guest" })).toBeNull();

    expect(screen.queryByRole("tree", { name: "Queries" })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "OFTC" })).getByRole("treeitem", {
        name: "guest",
      }),
    ).toBeTruthy();
  });

  it("draws a network's channels before its queries", () => {
    seedStore(
      [makeNetwork("libera", { name: "Libera.Chat" })],
      [makeChannel("libera", "#hackint"), makeChannel("libera", "#ctf-ops")],
      [makeQuery("libera", "sable"), makeQuery("libera", "phrack")],
    );
    render(<SidebarNetworks />);

    expect(
      within(screen.getByRole("group", { name: "Libera.Chat" }))
        .getAllByRole("treeitem")
        .map((row) => row.textContent),
    ).toEqual(["#ctf-ops", "#hackint", "phrack", "sable"]);
  });

  it("marks channels and queries that hold unsent drafts", () => {
    seedStore(
      [makeNetwork("libera", { name: "Libera.Chat" })],
      [makeChannel("libera", "#ctf-ops")],
      [makeQuery("libera", "phrack")],
    );
    useAppStore.getState().setDraftPresence("libera", "#ctf-ops", true);
    useAppStore.getState().setDraftPresence("libera", "phrack", true);
    render(<SidebarNetworks />);

    expect(screen.getByRole("treeitem", { name: "#ctf-ops, draft" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "phrack, draft" })).toBeTruthy();
    expect(screen.getAllByTitle("Unsent draft")).toHaveLength(2);
  });

  it("filters conversations and keeps each network visible", () => {
    seedStore(
      [
        makeNetwork("libera", { name: "Libera.Chat" }),
        makeNetwork("oftc", { name: "OFTC" }),
      ],
      [
        makeChannel("libera", "#quiet", { unread: 4 }),
        makeChannel("libera", "#loud", { unread: 4, highlights: 2 }),
        makeChannel("oftc", "#read"),
      ],
      [makeQuery("libera", "phrack", { unread: 1 })],
    );
    useAppStore.getState().setSidebarFilter("mentions");
    render(<SidebarNetworks />);

    expect(screen.getByText("Mentions")).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#loud" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "phrack" })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "#quiet" })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "#read" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /^OFTC,/ })).toBeTruthy();
    expect(screen.getByText("No matching conversations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear sidebar filter" }));
    expect(screen.getByRole("treeitem", { name: "#quiet" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "#read" })).toBeTruthy();
  });

  it("filters to conversations with drafts", () => {
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#draft"), makeChannel("libera", "#read")],
      [makeQuery("libera", "phrack")],
    );
    useAppStore.getState().setDraftPresence("libera", "#draft", true);
    useAppStore.getState().setSidebarFilter("drafts");
    render(<SidebarNetworks />);

    expect(screen.getByRole("treeitem", { name: "#draft, draft" })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "#read" })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "phrack" })).toBeNull();
  });

  it("keeps the network order the store gives it", () => {
    seedMockupWorkspace();
    render(<SidebarNetworks />);

    const groups = within(screen.getByRole("tree", { name: "Networks and conversations" }))
      .getAllByRole("treeitem")
      .filter((row) => row.getAttribute("aria-level") === "1")
      .map((row) => row.getAttribute("aria-label")?.split(",")[0]);
    expect(groups).toEqual(["Libera.Chat", "OFTC", "Rizon"]);
  });

  it("collapsing hides the panel's conversations and surfaces their unread total", () => {
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide conversations" }));

    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "#ctf-ops" })).toBeNull();
    // Direct messages keep their count when the network is collapsed. Ordinary
    // channel activity stays present without adding seven more to that badge.
    expect(screen.queryByRole("treeitem", { name: "phrack" })).toBeNull();
    expect(within(group).getByText("2")).toBeTruthy();
    expect(within(group).queryByText("9")).toBeNull();

    openRowMenu("Libera.Chat");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show conversations" }));
    expect(screen.getByRole("treeitem", { name: "#ctf-ops" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "phrack" })).toBeTruthy();
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

  it("marks ordinary unread quietly and counts highlights", () => {
    seedStore(
      [makeNetwork("libera")],
      [
        makeChannel("libera", "#quiet", { unread: 6 }),
        makeChannel("libera", "#loud", { unread: 36, highlights: 2 }),
      ],
    );
    render(<SidebarNetworks />);

    const quiet = within(screen.getByRole("treeitem", { name: "#quiet" }));
    const loud = within(screen.getByRole("treeitem", { name: "#loud" })).getByText("2");

    expect(quiet.getByLabelText("6 unread messages").className).toContain("bg-[var(--accent)]");
    expect(quiet.queryByText("6")).toBeNull();
    expect(loud.className).toContain("bg-[var(--badge-highlight-bg)]");
    expect(within(screen.getByRole("treeitem", { name: "#loud" })).queryByText("36")).toBeNull();
  });

  it("marks ordinary unread on a collapsed network without a number", () => {
    seedStore(
      [makeNetwork("libera", { name: "Libera.Chat" })],
      [makeChannel("libera", "#quiet", { unread: 6 })],
    );
    useAppStore.setState({ collapsedNetworks: { libera: true } });
    render(<SidebarNetworks />);

    const group = screen.getByRole("treeitem", { name: /^Libera\.Chat,/ });
    expect(within(group).getByLabelText("6 unread messages")).toBeTruthy();
    expect(within(group).queryByText("6")).toBeNull();
  });

  /** The row is where somebody asks why a channel never went loud. The settings
   * window only knows the one conversation the client was on, so without this a
   * mute made elsewhere reads as a broken channel. */
  it("marks a muted conversation, and leaves the count beside it", () => {
    seedStore(
      [makeNetwork("libera")],
      [
        makeChannel("libera", "#loud", { unread: 3 }),
        makeChannel("libera", "#quiet", { unread: 3, muted: true }),
      ],
      [makeQuery("libera", "buildbot", { unread: 1, muted: true })],
    );
    render(<SidebarNetworks />);

    const quiet = screen.getByRole("treeitem", { name: "#quiet" });
    expect(within(quiet).getByLabelText("Muted")).toBeTruthy();
    expect(within(quiet).getByLabelText("3 unread messages")).toBeTruthy();

    const loud = screen.getByRole("treeitem", { name: "#loud" });
    expect(within(loud).queryByLabelText("Muted")).toBeNull();

    const query = screen.getByRole("treeitem", { name: "buildbot" });
    expect(within(query).getByLabelText("Muted")).toBeTruthy();
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

    it("left arrow on a query returns to its network row, past the channels", () => {
      seedStore(
        [makeNetwork("libera", { name: "Libera.Chat" })],
        [makeChannel("libera", "#ctf-ops")],
        [makeQuery("libera", "phrack")],
      );
      render(<SidebarNetworks />);
      const query = screen.getByRole("treeitem", { name: "phrack" });
      act(() => query.focus());

      fireEvent.keyDown(query, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(
        screen.getByRole("treeitem", { name: /^Libera\.Chat,/ }),
      );
    });
  });
});

/**
 * #121: `close_target` was reachable from nowhere, so a channel joined once
 * stayed in the sidebar and came back on the next launch, and a query opened by
 * accident was permanent.
 */
describe("closing a conversation", () => {
  function seedOne() {
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#ctf-ops")],
      [makeQuery("libera", "sable")],
    );
    render(<SidebarNetworks />);
  }

  it("offers close on a channel and on a query from the ×", () => {
    seedOne();

    expect(screen.getByRole("button", { name: "Leave and close #ctf-ops" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close sable" })).toBeTruthy();
  });

  it("closes a channel from its ×", async () => {
    seedOne();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave and close #ctf-ops" }));
    });

    expect(ipc.closeTarget).toHaveBeenCalledWith("libera", "#ctf-ops");
  });

  it("closes a query from its ×", async () => {
    seedOne();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close sable" }));
    });

    expect(ipc.closeTarget).toHaveBeenCalledWith("libera", "sable");
  });

  it("opens the same menu on a right-click", () => {
    seedOne();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "sable" }));

    expect(screen.getByRole("menuitem", { name: "Close" })).toBeTruthy();
  });

  it("pins and unpins a conversation from its menu", () => {
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#alpha"), makeChannel("libera", "#zulu")],
    );
    render(<SidebarNetworks />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "#zulu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));

    const rows = () =>
      within(screen.getByRole("group", { name: "libera" }))
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-label"));
    expect(rows()).toEqual(["#zulu, pinned", "#alpha"]);
    expect(screen.getByTitle("Pinned")).toBeTruthy();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "#zulu, pinned" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));

    expect(rows()).toEqual(["#alpha", "#zulu"]);
  });

  it("puts the menu away once a conversation is closed", async () => {
    seedOne();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "sable" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  /** The row goes when the backend says it went, not when the click happened —
   * so a close that fails leaves the conversation where it was. */
  it("drops the row when the backend reports the query closed", async () => {
    seedOne();
    expect(screen.getByRole("treeitem", { name: "sable" })).toBeTruthy();

    act(() => {
      useAppStore.getState().applyEvent({
        type: "queryRemoved",
        network: "libera",
        nick: "sable",
      });
    });

    expect(screen.queryByRole("treeitem", { name: "sable" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "#ctf-ops" })).toBeTruthy();
  });
});

/**
 * #130: the only route to either was the command palette, and it offered
 * Connect while a network was failing — which is exactly when somebody wants to
 * stop the retry loop. The network row's menu is where they looked.
 */
describe("starting and stopping a network", () => {
  function seedWith(state: Network["status"]) {
    seedStore([makeNetwork("libera", { name: "Libera.Chat", status: state })]);
    render(<SidebarNetworks />);
    fireEvent.click(screen.getByRole("button", { name: "Libera.Chat actions" }));
  }

  it("offers to stop a network that is connected", () => {
    seedWith({ state: "connected" });
    expect(screen.getByRole("menuitem", { name: "Disconnect" })).toBeTruthy();
  });

  /** The state this was filed for. A failing network alternates between
   * `failed` and `reconnecting`; both mean there is a loop to stop. */
  it("offers to stop a network that is failing rather than to start it", () => {
    seedWith({ state: "failed", detail: { message: "connection refused" } });
    expect(screen.getByRole("menuitem", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reconnect now" })).toBeTruthy();
  });

  it("states the failed retry and its reason on the row", () => {
    seedWith({ state: "failed", detail: { message: "Connection refused" } });
    expect(
      screen.getByRole("treeitem", {
        name: "Libera.Chat, Connection failed, Retry failed: Connection refused",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Retry failed: Connection refused")).toBeTruthy();
  });

  it("states when the next retry starts", () => {
    seedWith({ state: "reconnecting", detail: { inSeconds: 12 } });
    expect(
      screen.getByRole("treeitem", {
        name: "Libera.Chat, Reconnecting, Retry in 12s",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Retry in 12s")).toBeTruthy();
  });

  it("restarts a failing network immediately", async () => {
    vi.mocked(ipc.disconnectNetwork).mockImplementationOnce(async () => {
      useAppStore.getState().applyEvent({
        type: "connectionChanged",
        network: "libera",
        status: { state: "disconnected" },
      });
    });
    vi.mocked(ipc.connectNetwork).mockImplementationOnce(async () => {
      useAppStore.getState().applyEvent({
        type: "connectionChanged",
        network: "libera",
        status: { state: "connected" },
      });
    });
    seedWith({ state: "failed", detail: { message: "Connection refused" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Reconnect now" }));
    });

    expect(screen.getByRole("treeitem", { name: "Libera.Chat, Connected" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers to start one that is stopped", () => {
    seedWith({ state: "disconnected" });
    expect(screen.getByRole("menuitem", { name: "Connect" })).toBeTruthy();
  });

  it("puts the menu away once the action is taken", () => {
    seedWith({ state: "connected" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("removes a network from its ×", async () => {
    seedStore([makeNetwork("libera", { name: "Libera.Chat" })]);
    render(<SidebarNetworks />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Libera.Chat" }));
    });

    expect(ipc.removeNetwork).toHaveBeenCalledWith("libera");
  });
});

/**
 * #153. `Query.online` crossed the boundary and nothing drew it, so a query
 * with somebody who had quit looked exactly like one with somebody there.
 */
describe("whether the other person is there", () => {
  function seedQuery(online: boolean) {
    seedStore(
      [makeNetwork("libera", { name: "Libera.Chat" })],
      [],
      [makeQuery("libera", "phrack", { online })],
    );
    render(<SidebarNetworks />);
  }

  it("says so in the row's name when they have quit", () => {
    seedQuery(false);
    expect(screen.getByRole("treeitem", { name: "phrack, offline" })).toBeTruthy();
  });

  it("says nothing extra when they are there", () => {
    seedQuery(true);
    expect(screen.getByRole("treeitem", { name: "phrack" })).toBeTruthy();
  });
});
