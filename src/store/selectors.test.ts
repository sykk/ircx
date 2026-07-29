import { renderHook, act } from "@testing-library/react";
import { useAppStore } from "./index";
import { useChannelsFor, useMembers, useNetworks, useQueriesFor, mentions } from "./selectors";
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

beforeEach(() => {
  useAppStore.setState({ networks: {}, networkOrder: [], channels: {}, queries: {}, members: {} });
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
