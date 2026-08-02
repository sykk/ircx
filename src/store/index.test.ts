import { beforeEach, describe, expect, it } from "vitest";
import { makeMessage } from "@/components/timeline/fixtures";
import {
  makeChannel,
  makeNetwork,
  makeQuery,
  oneView,
  resetStore,
  seedStore,
} from "@/components/shell/fixtures";
import { SERVER_TARGET, type IrcxEvent } from "@/types";
import { useAppStore } from "./index";
import { targetKey } from "./keys";
import { ratioOf } from "./layout";
import type { StoredLayout } from "./types";

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

/**
 * #234 fixed the roster half of a rename. A query is not a name in a list but
 * everything the store keys by that name, and the walk that found this showed
 * one conversation as two rows — the older holding the history behind a
 * composer addressed to a nick nobody held any more.
 */
describe("a query whose other end renames", () => {
  const OLD = targetKey("libera", "oldname");
  const NEW = targetKey("libera", "newname");

  function withQuery() {
    useAppStore.setState({
      queries: {
        [OLD]: { network: "libera", nick: "oldname", account: null, unread: 2, online: true },
      },
      timelines: {
        [OLD]: {
          messages: [makeMessage({ id: "a", nick: "oldname", target: "oldname" })],
          unreadFrom: null,
          hasMore: false,
          loadingOlder: false,
        },
      },
      replyTo: { [OLD]: "msgid-1" },
      recent: [OLD],
    });
  }

  function rename() {
    useAppStore.getState().applyEvent({
      type: "queryRenamed",
      network: "libera",
      from: "oldname",
      to: "newname",
    });
  }

  it("leaves one row, under the new name", () => {
    withQuery();
    rename();

    const { queries } = useAppStore.getState();
    expect(Object.keys(queries)).toEqual([NEW]);
    expect(queries[NEW]?.nick).toBe("newname");
  });

  it("takes the conversation with it", () => {
    withQuery();
    rename();

    const { timelines } = useAppStore.getState();
    expect(timelines[OLD]).toBeUndefined();
    expect(timelines[NEW]?.messages.map((m) => m.id)).toEqual(["a"]);
  });

  it("takes what the next message answers, and where it sat in the recents", () => {
    withQuery();
    rename();

    const { replyTo, recent } = useAppStore.getState();
    expect(replyTo[NEW]).toBe("msgid-1");
    expect(replyTo[OLD]).toBeUndefined();
    expect(recent).toEqual([NEW]);
  });

  /** A pane reading the conversation keeps reading it rather than emptying. */
  it("moves a pane that was looking at them", () => {
    withQuery();
    useAppStore.setState(oneView({ network: "libera", target: "oldname" }));
    rename();

    const { views } = useAppStore.getState();
    expect(Object.values(views).map((v) => v.target)).toEqual(["newname"]);
  });

  /** Two conversations meeting is not a move: the one already read wins, and
   * nothing is silently overwritten. */
  it("keeps what is already under the new name", () => {
    withQuery();
    useAppStore.setState({
      queries: {
        ...useAppStore.getState().queries,
        [NEW]: { network: "libera", nick: "newname", account: null, unread: 9, online: true },
      },
    });
    rename();

    expect(useAppStore.getState().queries[NEW]?.unread).toBe(9);
  });

  it("does nothing when the name only changes case", () => {
    withQuery();
    useAppStore.getState().applyEvent({
      type: "queryRenamed",
      network: "libera",
      from: "oldname",
      to: "OldName",
    });

    expect(Object.keys(useAppStore.getState().queries)).toEqual([OLD]);
  });
});

describe("the lines a conversation remembers", () => {
  function remember(...lines: string[]) {
    for (const line of lines) {
      useAppStore.getState().rememberInput("libera", "#ctf-ops", line);
    }
    return useAppStore.getState().inputHistory[KEY];
  }

  it("puts the most recent line first", () => {
    expect(remember("first", "second")).toEqual(["second", "first"]);
  });

  it("keeps one entry for a line sent twice running", () => {
    expect(remember("again", "again")).toEqual(["again"]);
  });

  it("keeps both when something was said in between", () => {
    expect(remember("again", "other", "again")).toEqual(["again", "other", "again"]);
  });

  it("drops the oldest past the cap", () => {
    const history = remember(...Array.from({ length: 105 }, (_, i) => `line ${i}`));
    expect(history).toHaveLength(100);
    expect(history?.[0]).toBe("line 104");
    expect(history?.at(-1)).toBe("line 5");
  });

  it("keeps each conversation's lines to itself", () => {
    remember("for the channel");
    useAppStore.getState().rememberInput("libera", "phrack", "for the query");

    expect(useAppStore.getState().inputHistory[KEY]).toEqual(["for the channel"]);
    expect(useAppStore.getState().inputHistory[targetKey("libera", "phrack")]).toEqual([
      "for the query",
    ]);
  });
});

describe("the panes a previous run left", () => {
  const pane = (target: string, raw = false): StoredLayout => ({
    type: "view",
    network: "libera",
    target,
    raw,
  });
  const sideBySide = (first: StoredLayout, second: StoredLayout): StoredLayout => ({
    type: "split",
    direction: "row",
    ratio: 0.7,
    children: [first, second],
  });

  beforeEach(() => {
    resetStore();
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#ctf-ops")],
      [makeQuery("libera", "phrack")],
    );
  });

  it("opens a pane on each conversation, keeping the share between them", () => {
    useAppStore.getState().restoreLayout(sideBySide(pane("#ctf-ops"), pane("phrack")));

    const { views, viewOrder, activeViewId, layout } = useAppStore.getState();
    expect(viewOrder).toHaveLength(2);
    expect(viewOrder.map((id) => views[id]?.target)).toEqual(["#ctf-ops", "phrack"]);
    expect(activeViewId).toBe(viewOrder[0]);
    expect(layout && ratioOf(layout)).toBe(0.7);
  });

  it("brings a console back on the protocol log it was showing", () => {
    useAppStore.getState().restoreLayout(pane(SERVER_TARGET, true));

    const { views, activeViewId } = useAppStore.getState();
    expect(activeViewId && views[activeViewId]?.raw).toBe(true);
  });

  /** The sidebar keeps a closed conversation closed across a restart, so a pane
   * that outlived one would draw a header for something the client has forgotten. */
  it("leaves behind a pane whose conversation is gone", () => {
    useAppStore.getState().restoreLayout(sideBySide(pane("#ctf-ops"), pane("#closed")));

    const { views, viewOrder, layout } = useAppStore.getState();
    expect(viewOrder).toHaveLength(1);
    expect(views[viewOrder[0]!]?.target).toBe("#ctf-ops");
    expect(layout?.type).toBe("view");
  });

  it("opens nothing at all when none of them are left", () => {
    useAppStore.getState().restoreLayout(sideBySide(pane("#closed"), pane("#gone")));

    expect(useAppStore.getState().layout).toBeNull();
    expect(useAppStore.getState().viewOrder).toEqual([]);
  });

  /** The snapshot can take long enough for somebody to click a channel, and what
   * they just opened is not something a restore should take away from them. */
  it("stands aside for a pane the user has already opened", () => {
    useAppStore.getState().showTarget({ network: "libera", target: "phrack" });
    useAppStore.getState().restoreLayout(sideBySide(pane("#ctf-ops"), pane("#ctf-ops")));

    const { views, viewOrder } = useAppStore.getState();
    expect(viewOrder).toHaveLength(1);
    expect(views[viewOrder[0]!]?.target).toBe("phrack");
  });
});

/**
 * A restore already drops the panes whose conversation is gone, so a pane that
 * survives a close is one the next launch would silently not reopen — and
 * until then it holds a composer addressed to a channel the client has left.
 */
describe("closing a conversation a pane is showing", () => {
  const store = () => useAppStore.getState();
  const targets = () => store().viewOrder.map((id) => store().views[id]!.target);
  const close = (target: string) =>
    store().applyEvent({ type: "channelRemoved", network: "libera", name: target });

  beforeEach(() => {
    resetStore();
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#ctf-ops"), makeChannel("libera", "#hackint")],
      [makeQuery("libera", "phrack")],
    );
  });

  it("takes the pane with it and collapses the split", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    store().setActive({ network: "libera", target: "#hackint" });

    close("#hackint");

    expect(targets()).toEqual(["#ctf-ops"]);
    expect(store().layout?.type).toBe("view");
    expect(store().activeViewId).toBe(store().viewOrder[0]);
  });

  /** Splitting opens the second pane on the same target, so two panes on one
   * conversation is what an ordinary split leaves. */
  it("takes every pane showing it, not just the first", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    store().splitActiveView("column");
    expect(targets()).toEqual(["#ctf-ops", "#ctf-ops", "#ctf-ops"]);

    store().setActive({ network: "libera", target: "#hackint" });
    close("#ctf-ops");

    expect(targets()).toEqual(["#hackint"]);
  });

  it("leaves a pane on another conversation alone", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    store().setActive({ network: "libera", target: "phrack" });
    const kept = store().activeViewId;

    close("#ctf-ops");

    expect(targets()).toEqual(["phrack"]);
    expect(store().activeViewId).toBe(kept);
  });

  /** The window always holds a pane, so the last one is emptied where the
   * others are removed — what `setActive(null)` leaves and `toStored` refuses
   * to write down. */
  it("empties the last pane rather than leaving the window with none", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");

    close("#ctf-ops");

    expect(store().viewOrder).toHaveLength(1);
    expect(targets()).toEqual([""]);
    expect(store().views[store().viewOrder[0]!]?.network).toBe("");
  });

  it("does the same for a query", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    store().setActive({ network: "libera", target: "phrack" });

    store().applyEvent({ type: "queryRemoved", network: "libera", nick: "phrack" });

    expect(targets()).toEqual(["#ctf-ops"]);
  });

  it("changes nothing when no pane is showing it", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    const before = store().layout;

    close("#hackint");

    expect(store().layout).toBe(before);
    expect(targets()).toEqual(["#ctf-ops"]);
  });
});

/**
 * A console saves no draft, so what is typed at one lives here rather than in
 * the pane drawing it — a change to the layout's shape rebuilds every pane in
 * the window (#308) and component state does not survive that. Living in the
 * store means it now has to be let go of at the points a pane does.
 */
describe("what a console pane holds", () => {
  const store = () => useAppStore.getState();

  beforeEach(() => {
    resetStore();
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    store().setActive({ network: "libera", target: SERVER_TARGET });
  });

  it("is kept per pane, so a split opens an empty box beside a typed one", () => {
    const typed = store().activeViewId!;
    store().setConsoleInput(typed, { text: "/whois phrack", error: null });

    store().splitActiveView("row");

    expect(store().consoleInput[typed]?.text).toBe("/whois phrack");
    expect(store().consoleInput[store().activeViewId!]).toBeUndefined();
  });

  it("is let go of when the pane is pointed at a conversation", () => {
    const view = store().activeViewId!;
    store().setConsoleInput(view, { text: "/whois phrack", error: null });

    store().setActive({ network: "libera", target: "#ctf-ops" });

    expect(store().consoleInput[view]).toBeUndefined();
  });

  /** Otherwise a later pane handed the same id opens with a command somebody
   * typed at a console that is gone — the reason `rosterHidden` is dropped in
   * the same place. */
  it("is let go of when the pane it was typed in closes", () => {
    store().splitActiveView("row");
    const opened = store().activeViewId!;
    store().setConsoleInput(opened, { text: "/quit", error: null });

    store().closeView(opened);

    expect(store().consoleInput[opened]).toBeUndefined();
  });

  it("is let go of when the console's network goes away", () => {
    const view = store().activeViewId!;
    store().setConsoleInput(view, { text: "/quit", error: null });

    store().applyEvent({ type: "networkRemoved", network: "libera" });

    expect(store().consoleInput[view]).toBeUndefined();
  });
});
