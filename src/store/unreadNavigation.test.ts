import { describe, expect, it } from "vitest";
import { useAppStore } from ".";
import { targetKey } from "./keys";
import { nextUnreadTarget } from "./unreadNavigation";
import type { Channel, Query } from "@/types";

function channel(name: string, unread: number, highlights = 0): Channel {
  return {
    network: "libera",
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 2,
    unread,
    highlights,
    muted: false,
  };
}

function query(nick: string, unread: number): Query {
  return { network: "libera", nick, account: null, unread, online: true, muted: false };
}

function state() {
  return {
    ...useAppStore.getState(),
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", "#alpha")]: channel("#alpha", 2),
      [targetKey("libera", "#bravo")]: channel("#bravo", 4, 1),
      [targetKey("libera", "#charlie")]: channel("#charlie", 3),
    },
    queries: { [targetKey("libera", "zebra")]: query("zebra", 1) },
  };
}

describe("nextUnreadTarget", () => {
  it("chooses a highlight before ordinary unread conversations", () => {
    expect(nextUnreadTarget(state(), targetKey("libera", "#alpha"), 1)).toBe(
      targetKey("libera", "#bravo"),
    );
  });

  it("follows sidebar order and wraps", () => {
    const withoutHighlights = state();
    withoutHighlights.channels[targetKey("libera", "#bravo")] = channel("#bravo", 4);

    expect(nextUnreadTarget(withoutHighlights, targetKey("libera", "zebra"), 1)).toBe(
      targetKey("libera", "#alpha"),
    );
    expect(nextUnreadTarget(withoutHighlights, targetKey("libera", "#alpha"), -1)).toBe(
      targetKey("libera", "zebra"),
    );
    expect(nextUnreadTarget(withoutHighlights, null, -1)).toBe(targetKey("libera", "zebra"));
  });

  it("moves to ordinary unread after the current highlight", () => {
    expect(nextUnreadTarget(state(), targetKey("libera", "#bravo"), 1)).toBe(
      targetKey("libera", "#charlie"),
    );
  });

  it("returns null when every conversation is read", () => {
    const read = state();
    read.channels = { [targetKey("libera", "#alpha")]: channel("#alpha", 0) };
    read.queries = {};

    expect(nextUnreadTarget(read, targetKey("libera", "#alpha"), 1)).toBeNull();
  });
});
