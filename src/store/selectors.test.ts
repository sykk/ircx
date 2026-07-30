import { renderHook, act } from "@testing-library/react";
import { useAppStore } from "./index";
import {
  useActiveTarget,
  useChannelsFor,
  useMembers,
  useNetworks,
  useQueriesFor,
  mentions,
} from "./selectors";
import type { ChatView } from "./types";
import type { Channel, Network } from "@/types";

function network(id: string): Network {
  return {
    id,
    name: id,
    host: `irc.${id}.net`,
    port: 6697,
    tls: true,
    status: { state: "connected" },
    currentNick: "sable",
    sasl: { state: "notConfigured" },
    capsEnabled: [],
    lagMs: null,
  };
}

function channel(net: string, name: string): Channel {
  return {
    network: net,
    name,
    topic: null,
    modes: "",
    joined: true,
    memberCount: 0,
    unread: 0,
    highlights: 0,
  };
}

function view(id: string, network: string, target: string): ChatView {
  return { id, network, target, scrollPosition: 0, selectedUser: null };
}

/** Two panes on one target, which no action opens yet — splits land in the next
 * issue and the model has to hold them before the UI can. */
function seedViews(...views: ChatView[]) {
  useAppStore.setState({
    views: Object.fromEntries(views.map((v) => [v.id, v])),
    viewOrder: views.map((v) => v.id),
    activeViewId: views[0]?.id ?? null,
  });
}

beforeEach(() => {
  useAppStore.setState({
    networks: {},
    networkOrder: [],
    channels: {},
    queries: {},
    members: {},
    timelines: {},
    views: {},
    viewOrder: [],
    activeViewId: null,
    recent: [],
  });
});

describe("selector reference stability", () => {
  // zustand 5 compares snapshots by identity. A selector that builds a fresh
  // array every read re-renders forever; React surfaces it as a getSnapshot
  // warning. These assert the identity, not the contents.

  it("keeps the same array when an unrelated slice changes", () => {
    act(() => {
      useAppStore.getState().applyEvent({ type: "networkUpdated", network: network("libera") });
    });

    const { result, rerender } = renderHook(() => useNetworks());
    const first = result.current;

    act(() => {
      useAppStore.setState({ sidebarWidth: 320 });
    });
    rerender();

    expect(result.current).toBe(first);
  });

  it("returns one shared empty array for an absent lookup", () => {
    const a = renderHook(() => useMembers("libera", "#nope"));
    const b = renderHook(() => useMembers("libera", "#also-nope"));
    expect(a.result.current).toBe(b.result.current);
  });

  it("returns a new array only when the derived contents change", () => {
    const { result, rerender } = renderHook(() => useChannelsFor("libera"));
    const empty = result.current;

    act(() => {
      useAppStore
        .getState()
        .applyEvent({ type: "channelUpdated", channel: channel("libera", "#ctf-ops") });
    });
    rerender();

    expect(result.current).not.toBe(empty);
    expect(result.current.map((c) => c.name)).toEqual(["#ctf-ops"]);
  });

  it("keeps the same active target across an unrelated change", () => {
    seedViews(view("a", "libera", "#ctf-ops"));

    const { result, rerender } = renderHook(() => useActiveTarget());
    const first = result.current;

    act(() => {
      useAppStore.setState({ sidebarWidth: 320 });
    });
    rerender();

    expect(result.current).toBe(first);
  });

  it("scopes derived lists to their network", () => {
    act(() => {
      const { applyEvent } = useAppStore.getState();
      applyEvent({ type: "channelUpdated", channel: channel("libera", "#a") });
      applyEvent({ type: "channelUpdated", channel: channel("oftc", "#b") });
    });

    const { result } = renderHook(() => useChannelsFor("libera"));
    expect(result.current.map((c) => c.name)).toEqual(["#a"]);
    expect(renderHook(() => useQueriesFor("libera")).result.current).toEqual([]);
  });
});

describe("view state", () => {
  it("scrolls two views on one target independently", () => {
    seedViews(view("a", "libera", "#ctf-ops"), view("b", "libera", "#ctf-ops"));

    const { setViewScroll } = useAppStore.getState();
    setViewScroll("a", 1200);
    setViewScroll("b", 40);

    const { views } = useAppStore.getState();
    expect(views.a!.scrollPosition).toBe(1200);
    expect(views.b!.scrollPosition).toBe(40);
  });

  it("resets scroll and the inspector when a view is retargeted", () => {
    seedViews(view("a", "libera", "#ctf-ops"));

    const store = useAppStore.getState();
    store.setViewScroll("a", 1200);
    store.setViewSelectedUser("a", "phrack");
    store.setActive({ network: "libera", target: "#hackint" });

    expect(useAppStore.getState().views.a).toEqual({
      id: "a",
      network: "libera",
      target: "#hackint",
      scrollPosition: 0,
      selectedUser: null,
    });
  });

  it("leaves the other view alone when one is retargeted", () => {
    seedViews(view("a", "libera", "#ctf-ops"), view("b", "libera", "#ctf-ops"));
    useAppStore.getState().setViewScroll("b", 40);

    useAppStore.getState().setActive({ network: "libera", target: "#hackint" });

    expect(useAppStore.getState().views.b).toEqual({
      ...view("b", "libera", "#ctf-ops"),
      scrollPosition: 40,
    });
  });

  it("opens a view and focuses it when there is none", () => {
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });

    const { views, viewOrder, activeViewId } = useAppStore.getState();
    expect(viewOrder).toHaveLength(1);
    expect(activeViewId).toBe(viewOrder[0]);
    expect(views[activeViewId!]).toMatchObject({ network: "libera", target: "#ctf-ops" });
  });

  it("blanks a view whose network went away rather than dropping it", () => {
    act(() => {
      useAppStore.getState().applyEvent({ type: "networkUpdated", network: network("libera") });
    });
    seedViews(view("a", "libera", "#ctf-ops"), view("b", "oftc", "#linux"));
    useAppStore.getState().setViewScroll("a", 1200);

    const { result } = renderHook(() => useActiveTarget());
    act(() => {
      useAppStore.getState().applyEvent({ type: "networkRemoved", network: "libera" });
    });

    const { views, viewOrder } = useAppStore.getState();
    expect(viewOrder).toEqual(["a", "b"]);
    expect(views.a).toEqual(view("a", "", ""));
    expect(views.b).toEqual(view("b", "oftc", "#linux"));
    expect(result.current).toBeNull();
  });
});

describe("mentions", () => {
  it("matches on word boundaries, not substrings", () => {
    expect(mentions("sable: ping", "sable")).toBe(true);
    expect(mentions("hey sable", "sable")).toBe(true);
    expect(mentions("sableton is here", "sable")).toBe(false);
    expect(mentions("unsable", "sable")).toBe(false);
  });

  it("treats the IRC nick punctuation set as part of the nick", () => {
    expect(mentions("hi [dev]", "[dev]")).toBe(true);
    expect(mentions("re: a|b done", "a|b")).toBe(true);
  });

  it("ignores case and an empty nick", () => {
    expect(mentions("SABLE: hi", "sable")).toBe(true);
    expect(mentions("anything", "")).toBe(false);
  });
});
