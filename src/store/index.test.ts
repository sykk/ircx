import { beforeEach, describe, expect, it } from "vitest";
import { makeMessage } from "@/components/timeline/fixtures";
import { makeChannel, makeNetwork, resetStore } from "@/components/shell/fixtures";
import type { IrcxEvent } from "@/types";
import { useAppStore } from "./index";
import { targetKey } from "./keys";

const KEY = targetKey("libera", "#ctf-ops");

function sent(id: string, text: string, timestamp: string) {
  const message = makeMessage({
    id,
    text,
    timestamp,
    nick: "sable",
    delivery: { state: "pending" },
  });
  message.sender.isSelf = true;
  return message;
}

function timeline() {
  return useAppStore.getState().timelines[KEY];
}

beforeEach(resetStore);

describe("the echo of a message you sent", () => {
  it("settles the copy already on screen without doubling it", () => {
    const optimistic = sent("local-1", "hello", "2026-07-30T13:06:14.000Z");
    const { applyEvent } = useAppStore.getState();

    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [optimistic],
    });
    applyEvent({
      type: "messageUpdated",
      message: { ...optimistic, delivery: { state: "delivered" } },
    });

    expect(timeline()?.messages).toHaveLength(1);
    expect(timeline()?.messages[0]?.delivery).toEqual({ state: "delivered" });
  });

  it("is drawn even when the window never held the copy it confirms", () => {
    useAppStore.getState().applyEvent({
      type: "messageUpdated",
      message: { ...sent("local-1", "hello", "2026-07-30T13:06:14.000Z"), delivery: { state: "delivered" } },
    });

    expect(timeline()?.messages.map((m) => m.id)).toEqual(["local-1"]);
  });

  it("lands at its own time rather than under whatever arrived meanwhile", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        makeMessage({ id: "early", timestamp: "2026-07-30T13:00:00.000Z" }),
        makeMessage({ id: "late", timestamp: "2026-07-30T13:10:00.000Z" }),
      ],
    });
    applyEvent({
      type: "messageUpdated",
      message: sent("local-1", "hello", "2026-07-30T13:06:14.000Z"),
    });

    expect(timeline()?.messages.map((m) => m.id)).toEqual(["early", "local-1", "late"]);
  });

  it("keeps what the timeline already knew about its own paging", () => {
    const { applyEvent, prependHistory } = useAppStore.getState();
    prependHistory(KEY, [makeMessage({ id: "old" })], false);
    applyEvent({
      type: "messageUpdated",
      message: sent("local-1", "hello", "2026-07-30T13:06:14.000Z"),
    });

    expect(timeline()?.hasMore).toBe(false);
  });
});

describe("a reaction", () => {
  function reaction(nick: string, emoji: string, active: boolean) {
    return {
      type: "reactionChanged",
      network: "libera",
      target: "#ctf-ops",
      message: "123",
      nick,
      emoji,
      active,
    } as const;
  }

  function reactions() {
    return timeline()?.messages[0]?.reactions;
  }

  beforeEach(() => {
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [makeMessage({ id: "123" })],
    });
  });

  it("collects names under the value they reacted with", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent(reaction("sable", "🇦🇷", true));
    applyEvent(reaction("phrack", "🇩🇪", true));
    applyEvent(reaction("nyx", "🇦🇷", true));

    expect(reactions()).toEqual([
      { emoji: "🇦🇷", nicks: ["sable", "nyx"] },
      { emoji: "🇩🇪", nicks: ["phrack"] },
    ]);
  });

  it("lands where one delta landed when the same one arrives twice", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent(reaction("sable", "lol", true));
    // The sender's own copy, and then the echo of it.
    applyEvent(reaction("sable", "lol", true));

    expect(reactions()).toEqual([{ emoji: "lol", nicks: ["sable"] }]);
  });

  it("takes the chip away with the last person holding it", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent(reaction("sable", "lol", true));
    applyEvent(reaction("phrack", "lol", true));
    applyEvent(reaction("sable", "lol", false));
    expect(reactions()).toEqual([{ emoji: "lol", nicks: ["phrack"] }]);

    applyEvent(reaction("phrack", "lol", false));
    expect(reactions()).toEqual([]);
  });

  it("is dropped without complaint when the window does not hold the message", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ ...reaction("sable", "lol", true), message: "not-in-the-window" });
    // Nothing was attached to any message here; the archive holds it instead.
    expect(reactions()).toBeUndefined();
  });

  it("finds a message you sent by the msgid its echo carried", () => {
    const ours = makeMessage({
      id: "local-1",
      idIsLocal: true,
      tags: [["msgid", "456"]],
    });
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [ours],
    });
    useAppStore.getState().applyEvent({ ...reaction("sable", "lol", true), message: "456" });

    expect(timeline()?.messages[1]?.reactions).toEqual([{ emoji: "lol", nicks: ["sable"] }]);
  });
});

describe("showing a target", () => {
  const store = () => useAppStore.getState();

  /** Two panes, the first on #ctf-ops and the second on #hackint, focused. */
  function twoPanes(): [string, string] {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    store().setActive({ network: "libera", target: "#hackint" });
    const [first, second] = store().viewOrder;
    return [first!, second!];
  }

  function targets(): string[] {
    return store().viewOrder.map((id) => store().views[id]!.target);
  }

  it("focuses the pane already showing it rather than taking over another", () => {
    const [first, second] = twoPanes();
    expect(store().activeViewId).toBe(second);

    store().showTarget({ network: "libera", target: "#ctf-ops" });

    expect(store().activeViewId).toBe(first);
    // The point of the change: neither pane was retargeted, so the
    // conversation the user was reading in the second pane is still there.
    expect(targets()).toEqual(["#ctf-ops", "#hackint"]);
  });

  it("matches the way a server does, not by exact spelling", () => {
    const [first] = twoPanes();
    store().showTarget({ network: "libera", target: "#CTF-Ops" });
    expect(store().activeViewId).toBe(first);
  });

  it("stays put when the focused pane is the one already showing it", () => {
    const [, second] = twoPanes();
    store().showTarget({ network: "libera", target: "#hackint" });
    expect(store().activeViewId).toBe(second);
  });

  it("takes the same network into account, not the target alone", () => {
    twoPanes();
    store().showTarget({ network: "hackint", target: "#ctf-ops" });

    // No pane is on that network, so the focused one goes there.
    expect(targets()).toEqual(["#ctf-ops", "#ctf-ops"]);
    expect(store().views[store().activeViewId!]!.network).toBe("hackint");
  });

  it("retargets the focused pane when nothing is showing it", () => {
    const [, second] = twoPanes();
    store().showTarget({ network: "libera", target: "#linux" });

    expect(store().activeViewId).toBe(second);
    expect(targets()).toEqual(["#ctf-ops", "#linux"]);
  });

  it("counts as reading it wherever it was already open", () => {
    const [first] = twoPanes();
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [KEY]: { messages: [], unreadFrom: "m-7", hasMore: true, loadingOlder: false },
      },
    }));

    store().showTarget({ network: "libera", target: "#ctf-ops" });

    expect(store().activeViewId).toBe(first);
    expect(store().timelines[KEY]!.unreadFrom).toBeNull();
    expect(store().recent[0]).toBe(KEY);
  });

  it("opens the first pane when there are none at all", () => {
    store().showTarget({ network: "libera", target: "#ctf-ops" });

    expect(store().viewOrder).toHaveLength(1);
    expect(targets()).toEqual(["#ctf-ops"]);
  });

  /** Splitting opens a second view on one target deliberately, so more than one
   * pane can be showing it. Pane order decides, rather than whichever the map
   * happened to yield. */
  it("takes the first in pane order when two panes show it", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    const [first, second] = store().viewOrder;
    expect(store().activeViewId).toBe(second);

    store().showTarget({ network: "libera", target: "#ctf-ops" });

    expect(store().activeViewId).toBe(first);
  });
});

/**
 * The backend delivers a window's worth of events as one message (#119). A
 * batch has to mean exactly what the same events mean one at a time — the
 * saving is one store write, not different behaviour.
 */
describe("a batch of events", () => {
  const store = () => useAppStore.getState();

  const events = (): IrcxEvent[] => [
    { type: "networkUpdated", network: makeNetwork("libera") },
    { type: "channelUpdated", channel: makeChannel("libera", "#ctf-ops") },
    { type: "channelUpdated", channel: makeChannel("libera", "#hackint") },
    { type: "channelRemoved", network: "libera", name: "#ctf-ops" },
  ];

  it("lands the same as the same events applied one at a time", () => {
    for (const event of events()) store().applyEvent(event);
    const separately = {
      networks: store().networks,
      channels: store().channels,
    };

    resetStore();
    store().applyEvents(events());

    expect(store().networks).toEqual(separately.networks);
    expect(store().channels).toEqual(separately.channels);
  });

  it("lets an event later in the batch see what an earlier one did", () => {
    store().applyEvents(events());

    // The removal is the fourth event and undoes the second. Reducing each
    // against the original state rather than the running one would keep it.
    expect(Object.keys(store().channels)).toEqual([targetKey("libera", "#hackint")]);
  });

  it("changes nothing when the batch is empty", () => {
    const before = store().channels;
    store().applyEvents([]);
    expect(store().channels).toBe(before);
  });
});

/**
 * A raise is what a notification rule produces. It is not drawn yet; what has
 * to hold now is that the window's copy of a message says the same thing the
 * archive would after a restart.
 */
describe("a message a notification rule raised", () => {
  function seed() {
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [KEY]: {
          messages: [makeMessage({ id: "m1", nick: "buildbot", text: "deploy failed on main" })],
          unreadFrom: null,
          hasMore: true,
          loadingOlder: false,
        },
      },
    }));
  }

  function raise(plugin: string): IrcxEvent {
    return {
      type: "messageRaised",
      network: "libera",
      target: "#ctf-ops",
      message: "m1",
      plugin,
    };
  }

  it("records which rule raised it", () => {
    seed();
    useAppStore.getState().applyEvent(raise("deploys"));

    expect(timeline()?.messages[0]?.raisedBy).toEqual(["deploys"]);
  });

  it("keeps both when two rules raise the same message", () => {
    seed();
    useAppStore.getState().applyEvent(raise("deploys"));
    useAppStore.getState().applyEvent(raise("oncall"));

    expect(timeline()?.messages[0]?.raisedBy).toEqual(["deploys", "oncall"]);
  });

  /** The archive holds one row per rule per message, so the window has to
   * agree: a rule raising twice is a rule raising once. */
  it("raises once for a rule that says so twice", () => {
    seed();
    useAppStore.getState().applyEvent(raise("deploys"));
    useAppStore.getState().applyEvent(raise("deploys"));

    expect(timeline()?.messages[0]?.raisedBy).toEqual(["deploys"]);
  });

  it("leaves a message nothing raised alone", () => {
    seed();
    expect(timeline()?.messages[0]?.raisedBy).toBeUndefined();
  });
});

/**
 * #219. A server backfill answers the join, and a channel that spoke while the
 * request was in flight puts a live message ahead of the history it answers.
 */
describe("a backfill of what was said while nobody was here", () => {
  function backfilled(id: string, timestamp: string) {
    return makeMessage({ id, timestamp, source: "serverHistory" });
  }

  it("lands at its own time rather than under what arrived first", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [makeMessage({ id: "live", timestamp: "2026-07-30T13:10:00.000Z" })],
    });
    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        backfilled("old-1", "2026-07-30T12:00:00.000Z"),
        backfilled("old-2", "2026-07-30T12:30:00.000Z"),
      ],
    });

    expect(timeline()?.messages.map((m) => m.id)).toEqual(["old-1", "old-2", "live"]);
  });

  it("interleaves with what was already held", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        makeMessage({ id: "live-1", timestamp: "2026-07-30T12:15:00.000Z" }),
        makeMessage({ id: "live-2", timestamp: "2026-07-30T13:10:00.000Z" }),
      ],
    });
    applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        backfilled("old-1", "2026-07-30T12:00:00.000Z"),
        backfilled("old-2", "2026-07-30T12:30:00.000Z"),
      ],
    });

    expect(timeline()?.messages.map((m) => m.id)).toEqual([
      "old-1",
      "live-1",
      "old-2",
      "live-2",
    ]);
  });

  it("does not move the seam that says where looking stopped", () => {
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [backfilled("old-1", "2026-07-30T12:00:00.000Z")],
    });

    expect(timeline()?.unreadFrom).toBeNull();
  });

  it("leaves the seam on the first live message in the same batch", () => {
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        backfilled("old-1", "2026-07-30T12:00:00.000Z"),
        makeMessage({ id: "live", timestamp: "2026-07-30T13:10:00.000Z" }),
      ],
    });

    expect(timeline()?.unreadFrom).toBe("live");
  });
});
