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
import {
  SERVER_TARGET,
  type ChatMessage,
  type IrcxEvent,
  type Member,
  type Transfer,
} from "@/types";
import { TIMELINE_CAP, useAppStore } from "./index";
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
      answers: null,
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
      answers: null,
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

describe("a read marker from another client", () => {
  it("moves the unread seam past the messages it covers", () => {
    const first = makeMessage({ id: "first", timestamp: "2026-08-15T12:00:00.000Z" });
    const ours = makeMessage({ id: "ours", timestamp: "2026-08-15T12:01:00.000Z" });
    ours.sender.isSelf = true;
    const later = makeMessage({ id: "later", timestamp: "2026-08-15T12:02:00.000Z" });
    useAppStore.setState((state) => ({
      timelines: {
        ...state.timelines,
        [KEY]: {
          messages: [first, ours, later],
          unreadFrom: "first",
          hasMore: false,
          loadingOlder: false,
          askedBehind: null,
          detachedAt: null,
        },
      },
    }));

    useAppStore.getState().applyEvent({
      type: "readMarkerUpdated",
      network: "libera",
      target: "#ctf-ops",
      timestamp: "2026-08-15T12:01:30.000Z",
    });

    expect(timeline()?.unreadFrom).toBe("later");
  });

  it("leaves a newer unread seam where it is", () => {
    const message = makeMessage({ id: "later", timestamp: "2026-08-15T12:02:00.000Z" });
    useAppStore.setState((state) => ({
      timelines: {
        ...state.timelines,
        [KEY]: {
          messages: [message],
          unreadFrom: "later",
          hasMore: false,
          loadingOlder: false,
          askedBehind: null,
          detachedAt: null,
        },
      },
    }));

    useAppStore.getState().applyEvent({
      type: "readMarkerUpdated",
      network: "libera",
      target: "#ctf-ops",
      timestamp: "2026-08-15T12:01:30.000Z",
    });

    expect(timeline()?.unreadFrom).toBe("later");
  });
});

/**
 * #566. The count came back on a reconnect and the rule did not: core counts a
 * page that fills a gap as unread, and the store refused to place a seam on
 * anything the server replayed. A reader was told there were three unread and
 * not which three. The marker is what says where they stopped, and it arrives
 * before the page it belongs to.
 */
describe("a page landing against a marker", () => {
  const KEY = targetKey("libera", "#ctf-ops");
  const timeline = () => useAppStore.getState().timelines[KEY];

  const missed = (id: string, timestamp: string): ChatMessage =>
    makeMessage({ id, timestamp, source: "serverHistory" });

  const page = (messages: ChatMessage[]): IrcxEvent => ({
    type: "messagesAppended",
    answers: null,
    network: "libera",
    target: "#ctf-ops",
    messages,
  });

  const marker = (timestamp: string): IrcxEvent => ({
    type: "readMarkerUpdated",
    network: "libera",
    target: "#ctf-ops",
    timestamp,
  });

  it("draws the rule at the first message the marker does not cover", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent(marker("2026-08-15T12:01:00.000Z"));
    applyEvent(
      page([
        missed("covered", "2026-08-15T12:00:30.000Z"),
        missed("first-unread", "2026-08-15T12:01:30.000Z"),
        missed("after", "2026-08-15T12:02:00.000Z"),
      ]),
    );

    expect(timeline()?.unreadFrom).toBe("first-unread");
  });

  /** And the same through the batching path `applyEvents` reads by, where the
   * marker and the page can arrive in one delivery. */
  it("draws it the same way inside a batch", () => {
    useAppStore
      .getState()
      .applyEvents([
        marker("2026-08-15T12:01:00.000Z"),
        page([
          missed("covered", "2026-08-15T12:00:30.000Z"),
          missed("first-unread", "2026-08-15T12:01:30.000Z"),
        ]),
      ]);

    expect(timeline()?.unreadFrom).toBe("first-unread");
  });

  /** A page every row of which the marker covers is a reconnect into a
   * conversation somebody else has already read. */
  it("leaves a page the marker covers unmarked", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent(marker("2026-08-15T12:05:00.000Z"));
    applyEvent(page([missed("covered", "2026-08-15T12:00:30.000Z")]));

    expect(timeline()?.unreadFrom).toBeNull();
  });

  /** The reader's own line is not something they were away for, wherever the
   * marker sits. */
  it("passes over the reader's own messages", () => {
    const { applyEvent } = useAppStore.getState();
    const own = missed("own", "2026-08-15T12:01:30.000Z");
    own.sender.isSelf = true;
    applyEvent(marker("2026-08-15T12:01:00.000Z"));
    applyEvent(page([own, missed("theirs", "2026-08-15T12:02:00.000Z")]));

    expect(timeline()?.unreadFrom).toBe("theirs");
  });

  /** Without a marker there is nothing to place a rule against, which is what
   * a server with no `draft/read-marker` gives and what #223 means by a first
   * page: it stays what was said before anybody looked. */
  it("marks nothing where the server has said nothing", () => {
    useAppStore.getState().applyEvent(page([missed("older", "2026-08-15T12:00:30.000Z")]));

    expect(timeline()?.unreadFrom).toBeNull();
  });

  /** The marker is kept for a conversation that has no timeline yet, which is
   * the usual way round: a channel's marker arrives with the join and its page
   * is still being asked for. */
  it("keeps a marker that arrives before any page", () => {
    useAppStore.getState().applyEvent(marker("2026-08-15T12:01:00.000Z"));

    expect(timeline()?.readMarker).toBe("2026-08-15T12:01:00.000Z");
  });
});

/** The raw log had the shape #321 fixed for rosters: a `/list` delivers tens
 * of thousands of `rawLine` events in one batch, and each copied the whole
 * capped log on its way in. Coalesced now, and `reduce` stays the one to
 * trust — this asserts the fast path agrees with it, cap included, across an
 * interleaved event that forces a mid-batch flush. */
describe("the raw log over one batch", () => {
  const store = () => useAppStore.getState();

  function line(network: string, n: number): IrcxEvent {
    return { type: "rawLine", network, line: `PING ${n}`, outgoing: n % 2 === 0 };
  }

  it("lands the same log as the same events applied one at a time", () => {
    const batch: IrcxEvent[] = [];
    for (let n = 0; n < 2_100; n++) batch.push(line("libera", n));
    batch.push({ type: "lagChanged", network: "libera", lagMs: 12 });
    for (let n = 0; n < 5; n++) batch.push(line("oftc", n));

    for (const event of batch) store().applyEvent(event);
    const oneAtATime = store().rawLog;

    resetStore();
    store().applyEvents(batch);

    expect(store().rawLog).toEqual(oneAtATime);
    expect(store().rawLog["libera"]).toHaveLength(2_000);
  });
});

/**
 * #618. A search jump does not scroll — it files a window read around the hit
 * over whatever the pane held, and that window can end well short of the
 * present. Nothing in the client ever asks for a message newer than the ones it
 * holds, so a window that stops short has to say so or the pane sits at the
 * bottom of it calling that the conversation.
 */
describe("a window filed over a conversation", () => {
  const said = (id: string, minute: number) =>
    makeMessage({ id, timestamp: `2026-08-15T12:${String(minute).padStart(2, "0")}:00.000Z` });

  function hold(messages: ChatMessage[]) {
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [KEY]: { ...s.timelines[KEY]!, messages },
      },
    }));
  }

  beforeEach(() => hold([]));

  it("is marked where it stops, when it stops behind what was on screen", () => {
    hold([said("old", 1), said("live", 30)]);

    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    expect(timeline()?.detachedAt).toBe("b");
  });

  it("is not marked when it ends on the message the pane was already at", () => {
    hold([said("a", 5), said("b", 6)]);

    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    expect(timeline()?.detachedAt).toBe(null);
  });

  /** The archive's own newest is not what a jump asks for, so nothing here can
   * say the window reaches it. Offering the way back costs a reader who did not
   * need it one reload; not offering it is the bug. */
  it("is marked when there was nothing on screen to compare it against", () => {
    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    expect(timeline()?.detachedAt).toBe("b");
  });

  it("clears the mark when the tail is read back over it", () => {
    hold([said("a", 5), said("b", 6)]);
    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    useAppStore.getState().replaceHistory(KEY, [said("y", 29), said("z", 30)]);

    expect(timeline()?.detachedAt).toBe(null);
  });

  /** The line that lands next is where the hole is, and the pane draws its rule
   * off the message above it. */
  it("keeps the mark where it is when the channel says something else", () => {
    hold([said("old", 1), said("live", 30)]);
    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [said("next", 31)],
      answers: null,
    });

    expect(timeline()?.detachedAt).toBe("b");
    expect(timeline()?.messages.map((m) => m.id)).toEqual(["a", "b", "next"]);
  });
});

/**
 * #623. Two of the fields `replaceHistory` reset are not facts about the window
 * it files: the seam, and the marker that places one in a page nobody was here
 * for. A jump is not a departure — `leftBehind` declines for the target already
 * on screen, and `readingTarget` says why — so both hold across it.
 */
describe("the seam under a window filed over a conversation", () => {
  const said = (id: string, minute: number) =>
    makeMessage({ id, timestamp: `2026-08-15T12:${String(minute).padStart(2, "0")}:00.000Z` });

  function hold(messages: ChatMessage[], unreadFrom: string | null, readMarker: string | null) {
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [KEY]: { ...s.timelines[KEY]!, messages, unreadFrom, readMarker },
      },
    }));
  }

  it("holds where the reader stopped, however far back the window lands", () => {
    hold([said("old", 1), said("live", 30)], "live", null);

    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    expect(timeline()?.unreadFrom).toBe("live");
  });

  /** The window the jump filed does not hold the message the seam names, and
   * the tail read back over it does. */
  it("has the message to draw the rule against again when the tail comes back", () => {
    hold([said("old", 1), said("live", 30)], "live", null);
    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    useAppStore.getState().replaceHistory(KEY, [said("live", 30), said("later", 31)]);

    expect(timeline()?.unreadFrom).toBe("live");
    expect(timeline()?.detachedAt).toBe(null);
  });

  /** The marker outlasts every window: nothing sets it but the server, so a
   * jump that took it left `seamAt` with nothing to place a rule against for
   * the rest of the session. #566. */
  it("keeps the marker a page nobody was here for is measured against", () => {
    const marker = "2026-08-15T12:10:00.000Z";
    hold([said("old", 1)], null, marker);
    useAppStore.getState().replaceHistory(KEY, [said("a", 5), said("b", 6)]);

    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ctf-ops",
      messages: [
        makeMessage({ id: "read", timestamp: "2026-08-15T12:09:00.000Z", source: "serverHistory" }),
        makeMessage({ id: "missed", timestamp: "2026-08-15T12:11:00.000Z", source: "serverHistory" }),
      ],
      answers: null,
    });

    expect(timeline()?.readMarker).toBe(marker);
    expect(timeline()?.unreadFrom).toBe("missed");
  });
});

describe("paging backwards", () => {
  /** #331 states the invariant — paging backwards stops at TIMELINE_CAP —
   * but only the auto-fill effect honoured it; the scroll handler paged
   * without a cap and the store took whatever it was handed. Holding
   * scroll-up against a deep archive grew the window without bound, and
   * every later live message paid O(window) for it. */
  it("stops at the cap the appends hold the other end to", () => {
    const seed = Array.from({ length: TIMELINE_CAP - 2 }, (_, i) =>
      makeMessage({ id: `m-${i}` }),
    );
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [KEY]: { messages: seed, unreadFrom: null, readMarker: null, hasMore: true, loadingOlder: true, askedBehind: null, detachedAt: null },
      },
    }));

    const page = Array.from({ length: 5 }, (_, i) => makeMessage({ id: `old-${i}` }));
    useAppStore.getState().prependHistory(KEY, page, true);

    const held = timeline()!;
    expect(held.messages).toHaveLength(TIMELINE_CAP);
    // The newest of the page is what fits, keeping the window contiguous.
    expect(held.messages[0]!.id).toBe("old-3");
    expect(held.messages[1]!.id).toBe("old-4");
    expect(held.hasMore).toBe(false);
    expect(held.loadingOlder).toBe(false);
  });

  it("keeps paging while there is room", () => {
    useAppStore
      .getState()
      .prependHistory(KEY, [makeMessage({ id: "old" })], true);

    expect(timeline()!.hasMore).toBe(true);
  });

  /** A pane that opens on an empty timeline asks the archive with `before`
   * null, and `load_history` reads that as "the newest page you hold" rather
   * than as a page behind anything. The read is awaited, so by the time it
   * lands the server's own `CHATHISTORY LATEST` can already be on screen —
   * and then the archive's newest, today's, is filed in front of yesterday. */
  it("orders a page that is not older than what arrived while it was read", () => {
    const yesterday = Array.from({ length: 3 }, (_, i) =>
      makeMessage({ id: `history-${i}`, timestamp: `2026-08-11T09:0${i}:00.000Z` }),
    );
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: yesterday,
    });

    const today = [
      makeMessage({ id: "joined", timestamp: "2026-08-12T12:06:19.829Z" }),
      makeMessage({ id: "created", timestamp: "2026-08-12T12:06:19.831Z" }),
    ];
    useAppStore.getState().prependHistory(KEY, today, true);

    expect(timeline()!.messages.map((m) => m.id)).toEqual([
      "history-0",
      "history-1",
      "history-2",
      "joined",
      "created",
    ]);
  });

  /**
   * #602. A server stamps at millisecond resolution and a burst arrives inside
   * one of them: `ergo` gave nine consecutive messages the same timestamp. So
   * the window holds a run of messages
   * the timestamp cannot order, and the page that lands in front of them shares
   * it — and a merge that reads the clock alone has nothing to go on.
   *
   * What it did was break the tie towards the window, which puts the arriving
   * page *after* messages it precedes, and then the rest of the page after the
   * first message whose stamp is different. The pane drew `line 0600` followed
   * by `line 0611`, with ten of its messages further down the block.
   */
  it("keeps a page in front of the tied stamps it is older than", () => {
    const burst = "2026-08-21T18:04:42.886Z";
    const after = "2026-08-21T18:04:42.887Z";
    const held = [
      ...Array.from({ length: 9 }, (_, i) => makeMessage({ id: `held-${611 + i}`, timestamp: burst })),
      ...Array.from({ length: 3 }, (_, i) => makeMessage({ id: `held-${620 + i}`, timestamp: after })),
    ];
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: held,
    });

    // The page the pane asked for, which is every message before `held-611`.
    // `serverHistory` is what a `CHATHISTORY` answer carries, and it is what
    // tells the merge these are older than a live line sharing their
    // millisecond rather than newer.
    const page = [
      makeMessage({
        id: "page-600",
        timestamp: "2026-08-21T18:04:42.885Z",
        source: "serverHistory",
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeMessage({ id: `page-${601 + i}`, timestamp: burst, source: "serverHistory" }),
      ),
    ];
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      answers: "ask-1",
      network: "libera",
      target: "#ctf-ops",
      messages: page,
    });

    expect(timeline()!.messages.map((m) => m.id)).toEqual([
      ...page.map((m) => m.id),
      ...held.map((m) => m.id),
    ]);
  });

  /** #487. What the server was asked for the page behind is what tells the next
   * scroll's request from the one already out, and the session abandons its
   * page-backs when the connection goes: a conversation still naming one would
   * decline to ask again for the rest of the run. */
  describe("what the server was asked for", () => {
    const asked = () => {
      useAppStore.getState().setAskedBehind(KEY, "msg-1");
      expect(timeline()!.askedBehind).toBe("msg-1");
    };
    const connection = (
      state: "connected" | "disconnected",
      network = "libera",
    ): IrcxEvent => ({ type: "connectionChanged", network, status: { state } });

    it("is forgotten when the connection goes", () => {
      asked();
      useAppStore.getState().applyEvents([connection("disconnected")]);

      expect(timeline()!.askedBehind).toBeNull();
    });

    it("stands while the connection does", () => {
      asked();
      useAppStore.getState().applyEvents([connection("connected")]);

      expect(timeline()!.askedBehind).toBe("msg-1");
    });

    it("is left alone on another network's connection", () => {
      asked();
      useAppStore.getState().applyEvents([connection("disconnected", "oftc")]);

      expect(timeline()!.askedBehind).toBe("msg-1");
    });

    /**
     * #522. A page of history arriving is what takes it off, and not the
     * window's oldest message moving. A page carrying only rows the pane
     * already holds moves that not at all — `#486`'s `CHATHISTORY LATEST` is a
     * whole page of them — so a guard waiting on it waited for the rest of the
     * run, refusing every scroll for a page that had already arrived.
     *
     * Where the history ends is the answer's own to say, and a batch says which
     * ask it answers: nothing in the one this pane is waiting on means the
     * server has nothing behind that message, and the paging stops rather than
     * the asking resuming (#540).
     */
    const arrived = (messages: ChatMessage[], answers: string | null = null): IrcxEvent => ({
      type: "messagesAppended",
      answers,
      network: "libera",
      target: "#ctf-ops",
      messages,
    });
    const alreadyHeld = () => {
      const message = makeMessage({ id: "msg-1", source: "serverHistory" });
      useAppStore.getState().applyEvent(arrived([message]));
      asked();
      return message;
    };

    it("is answered by a page the window keeps nothing of", () => {
      const message = alreadyHeld();
      useAppStore.getState().applyEvent(arrived([message], "msg-1"));

      expect(timeline()!.askedBehind).toBeNull();
      expect(timeline()!.hasMore).toBe(false);
    });

    /** And the same through the batching path, which `applyEvents` reads by. */
    it("is answered by that page inside a batch", () => {
      const message = alreadyHeld();
      useAppStore.getState().applyEvents([arrived([message], "msg-1")]);

      expect(timeline()!.askedBehind).toBeNull();
      expect(timeline()!.hasMore).toBe(false);
    });

    /** A page that carried something is an answer too, and one with history
     * behind it: the paging goes on. */
    it("is answered by a page that carried history, without ending it", () => {
      alreadyHeld();
      useAppStore.getState().applyEvents([
        arrived(
          [
            makeMessage({
              id: "older-1",
              source: "serverHistory",
              timestamp: "2026-07-01T00:00:00.000Z",
            }),
          ],
          "msg-1",
        ),
      ]);

      expect(timeline()!.askedBehind).toBeNull();
      expect(timeline()!.hasMore).toBe(true);
    });

    /** A channel does not go quiet because somebody is paging through it, and
     * a line said at the live edge answers nothing. */
    it("stands while what arrives is somebody talking", () => {
      alreadyHeld();
      useAppStore
        .getState()
        .applyEvents([arrived([makeMessage({ id: "live", timestamp: "2026-08-01T00:00:00.000Z" })])]);

      expect(timeline()!.askedBehind).toBe("msg-1");
      expect(timeline()!.hasMore).toBe(true);
    });

    /** Nobody was waiting, so nothing is concluded from it. A backfill after a
     * reconnect lands on conversations no reader has scrolled in, and a page
     * whose rows are all held is what a reconnect into a quiet channel gets. */
    it("ends nothing where no ask was outstanding", () => {
      const message = makeMessage({ id: "msg-1", source: "serverHistory" });
      useAppStore.getState().applyEvent(arrived([message]));
      useAppStore.getState().applyEvent(arrived([message]));

      expect(timeline()!.hasMore).toBe(true);
    });

    /** A page-back the client gave up on is answered all the same: the round
     * trip's deadline is 60s and `answered_in_time` reads passing it as
     * "nothing failed, the answer may still arrive". So the reader asks again,
     * the server answers both, and the second answer carries the page the
     * first one already delivered — against a guard armed for the question
     * after it. Nothing in it is new, and this concluded the server had
     * nothing behind a message it was never asked about. */
    it("does not end the history on the answer to an ask two questions old", () => {
      const page = [
        makeMessage({
          id: "older-1",
          source: "serverHistory",
          timestamp: "2026-07-01T00:00:00.000Z",
        }),
      ];
      useAppStore.getState().applyEvent(arrived(page, "msg-1"));
      // The reader scrolls on, and the next ask goes out behind the page that
      // landed rather than behind the message that page was asked for.
      useAppStore.getState().setAskedBehind(KEY, "older-1");
      // The answer to the ask they gave up on, arriving last and naming it.
      useAppStore.getState().applyEvent(arrived(page, "msg-1"));

      expect(timeline()!.hasMore).toBe(true);
      expect(timeline()!.askedBehind).toBe("older-1");
    });
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
      answers: null,
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
      answers: null,
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

  function markUnread(key: string, from: string) {
    useAppStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [key]: { messages: [], unreadFrom: from, readMarker: null, hasMore: true, loadingOlder: false, askedBehind: null, detachedAt: null },
      },
    }));
  }

  /** The seam is what the reader switched here to see: it survives the
   * switch and holds while they read. Clearing it on arrival made it
   * unreachable in a single-pane window — every path to a conversation went
   * through the clear. */
  it("keeps the seam of the conversation being switched to", () => {
    const [first] = twoPanes();
    markUnread(KEY, "m-7");

    store().showTarget({ network: "libera", target: "#ctf-ops" });

    expect(store().activeViewId).toBe(first);
    expect(store().timelines[KEY]!.unreadFrom).toBe("m-7");
    expect(store().recent[0]).toBe(KEY);
  });

  it("clears the seam of a conversation left off the screen", () => {
    store().setActive({ network: "libera", target: "#ctf-ops" });
    markUnread(KEY, "m-7");
    store().setActive({ network: "libera", target: "#hackint" });

    expect(store().timelines[KEY]!.unreadFrom).toBeNull();
  });

  it("holds the seam while another pane still shows the conversation", () => {
    // Both panes on #ctf-ops, then the focused one moves away.
    store().setActive({ network: "libera", target: "#ctf-ops" });
    store().splitActiveView("row");
    markUnread(KEY, "m-7");
    store().setActive({ network: "libera", target: "#hackint" });

    expect(store().timelines[KEY]!.unreadFrom).toBe("m-7");
  });

  it("clears the seam when closing the focused pane takes it off the screen", () => {
    const [, second] = twoPanes();
    const hackint = targetKey("libera", "#hackint");
    markUnread(hackint, "m-7");

    store().closeView(second);

    expect(store().timelines[hackint]!.unreadFrom).toBeNull();
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
          unreadFrom: null, readMarker: null,
          hasMore: true,
          loadingOlder: false, askedBehind: null, detachedAt: null
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
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [makeMessage({ id: "live", timestamp: "2026-07-30T13:10:00.000Z" })],
    });
    applyEvent({
      type: "messagesAppended",
      answers: null,
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
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [
        makeMessage({ id: "live-1", timestamp: "2026-07-30T12:15:00.000Z" }),
        makeMessage({ id: "live-2", timestamp: "2026-07-30T13:10:00.000Z" }),
      ],
    });
    applyEvent({
      type: "messagesAppended",
      answers: null,
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
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [backfilled("old-1", "2026-07-30T12:00:00.000Z")],
    });

    expect(timeline()?.unreadFrom).toBeNull();
  });

  it("leaves the seam on the first live message in the same batch", () => {
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      answers: null,
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
        [OLD]: { network: "libera", nick: "oldname", account: null, unread: 2, online: true, muted: false },
      },
      timelines: {
        [OLD]: {
          messages: [makeMessage({ id: "a", nick: "oldname", target: "oldname" })],
          unreadFrom: null, readMarker: null,
          hasMore: false,
          loadingOlder: false, askedBehind: null, detachedAt: null
        },
      },
      replyTo: { [OLD]: "msgid-1" },
      recent: [OLD],
      pinnedTargets: [OLD],
      drafts: { [OLD]: true },
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

  it("takes its draft with it", () => {
    withQuery();
    rename();

    expect(useAppStore.getState().drafts).toEqual({ [NEW]: true });
  });

  it("takes its pin with it", () => {
    withQuery();
    rename();

    expect(useAppStore.getState().pinnedTargets).toEqual([NEW]);
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

describe("draft presence", () => {
  it("appears and clears with the composer", () => {
    useAppStore.getState().setDraftPresence("libera", "#ctf-ops", true);
    expect(useAppStore.getState().drafts[KEY]).toBe(true);

    useAppStore.getState().setDraftPresence("libera", "#ctf-ops", false);
    expect(useAppStore.getState().drafts[KEY]).toBeUndefined();
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

/** The sidebar, the Networks page and which conversation the app opens on all
 * read `networkOrder`, and it used to be the order the events arrived in. Each
 * network is a lane of its own in the pump, so that was the order they
 * connected in: two dialling at once came out reversed between one launch and
 * the next. See #480. */
describe("the order the networks are in", () => {
  const store = () => useAppStore.getState();

  const arrives = (id: string, name: string) =>
    store().applyEvent({ type: "networkUpdated", network: makeNetwork(id, { name }) });

  it("is the names, whichever of them answered first", () => {
    arrives("n1", "Zulu");
    arrives("n2", "Alpha");

    expect(store().networkOrder).toEqual(["n2", "n1"]);
  });

  it("does not depend on the case they were typed in", () => {
    arrives("n1", "Beta");
    arrives("n2", "alpha");

    expect(store().networkOrder).toEqual(["n2", "n1"]);
  });

  it("moves a network that was renamed", () => {
    arrives("n1", "Alpha");
    arrives("n2", "Beta");
    expect(store().networkOrder).toEqual(["n1", "n2"]);

    arrives("n1", "Zulu");

    expect(store().networkOrder).toEqual(["n2", "n1"]);
  });

  // Nothing makes a name unique, and a stable sort would leave the pair in
  // whichever order they arrived — which is the race, kept inside the tie.
  it("settles two of the same name on their ids", () => {
    arrives("n2", "Libera");
    arrives("n1", "Libera");

    expect(store().networkOrder).toEqual(["n1", "n2"]);
  });
});

/** A removed network dropped its channels, queries, timelines and members —
 * and left everything else it keyed: typing expiries, reply targets, input
 * history, up to 2,000 raw-log lines and a whole /list answer, forever. A
 * network re-added under the same id resurrected the lot, and editing
 * networks grew the store monotonically. */
describe("removing a network", () => {
  const store = () => useAppStore.getState();
  const gone = targetKey("libera", "#ctf-ops");
  const kept = targetKey("oftc", "#tor");

  beforeEach(() => {
    resetStore();
    seedStore(
      [makeNetwork("libera"), makeNetwork("oftc")],
      [makeChannel("libera", "#ctf-ops"), makeChannel("oftc", "#tor")],
    );
    for (const network of ["libera", "oftc"]) {
      store().applyEvent({ type: "rawLine", network, line: "PING", outgoing: false });
      store().applyEvent({
        type: "channelsListed",
        network,
        channels: [],
        truncated: false,
      });
    }
    store().setReplyTo("libera", "#ctf-ops", "msg-1");
    store().setReplyTo("oftc", "#tor", "msg-2");
    store().rememberInput("libera", "#ctf-ops", "typed here");
    store().rememberInput("oftc", "#tor", "typed there");
    store().togglePinnedTarget(gone);
    store().togglePinnedTarget(kept);
    store().showTarget({ network: "libera", target: "#ctf-ops" });

    store().applyEvent({ type: "networkRemoved", network: "libera" });
  });

  it("takes every map the network keyed with it", () => {
    expect(store().rawLog["libera"]).toBeUndefined();
    expect(store().channelList["libera"]).toBeUndefined();
    expect(store().replyTo[gone]).toBeUndefined();
    expect(store().inputHistory[gone]).toBeUndefined();
    expect(store().recent).not.toContain(gone);
    expect(store().pinnedTargets).not.toContain(gone);
  });

  it("leaves the other networks' entries standing", () => {
    expect(store().rawLog["oftc"]).toHaveLength(1);
    expect(store().channelList["oftc"]).toBeTruthy();
    expect(store().replyTo[kept]).toBe("msg-2");
    expect(store().inputHistory[kept]).toEqual(["typed there"]);
    expect(store().pinnedTargets).toContain(kept);
  });
});

/** The same rule as `consoleInput`, for the other thing a console pane draws.
 * See #315. */
describe("where a pane is reading the protocol log", () => {
  const store = () => useAppStore.getState();

  beforeEach(() => {
    resetStore();
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    store().setActive({ network: "libera", target: SERVER_TARGET });
  });

  it("is let go of when the pane is pointed at a conversation", () => {
    const view = store().activeViewId!;
    store().setRawAnchor(view, 400);

    store().setActive({ network: "libera", target: "#ctf-ops" });

    expect(store().rawAnchor[view]).toBeUndefined();
  });

  it("is let go of when the pane reading it closes", () => {
    store().splitActiveView("row");
    const opened = store().activeViewId!;
    store().setRawAnchor(opened, 400);

    store().closeView(opened);

    expect(store().rawAnchor[opened]).toBeUndefined();
  });

  it("is let go of when the log's network goes away", () => {
    const view = store().activeViewId!;
    store().setRawAnchor(view, 400);

    store().applyEvent({ type: "networkRemoved", network: "libera" });

    expect(store().rawAnchor[view]).toBeUndefined();
  });
});

/** The last of the three pane-scoped maps, released at the same points. #308. */
describe("why a pane's last line was refused", () => {
  const store = () => useAppStore.getState();

  beforeEach(() => {
    resetStore();
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    store().setActive({ network: "libera", target: "#ctf-ops" });
  });

  it("is let go of when the pane is pointed at another conversation", () => {
    const view = store().activeViewId!;
    store().setComposerError(view, "Cannot send to channel");

    store().setActive({ network: "libera", target: SERVER_TARGET });

    expect(store().composerError[view]).toBeUndefined();
  });

  it("is let go of when the pane that earned it closes", () => {
    store().splitActiveView("row");
    const opened = store().activeViewId!;
    store().setComposerError(opened, "Cannot send to channel");

    store().closeView(opened);

    expect(store().composerError[opened]).toBeUndefined();
  });

  it("is let go of when the conversation is closed under the pane", () => {
    const view = store().activeViewId!;
    store().splitActiveView("row");
    store().setComposerError(view, "Cannot send to channel");

    store().applyEvent({ type: "channelRemoved", network: "libera", name: "#ctf-ops" });

    expect(store().composerError[view]).toBeUndefined();
  });

  it("is let go of when the network goes away", () => {
    const view = store().activeViewId!;
    store().setComposerError(view, "Cannot send to channel");

    store().applyEvent({ type: "networkRemoved", network: "libera" });

    expect(store().composerError[view]).toBeUndefined();
  });
});

/**
 * `dropByNetwork` built its prefix with a literal space where `targetKey` joins
 * with `SEP`, which is a NUL. The two never matched, so deleting a network left
 * every channel, query, timeline and roster it owned in the store — the views
 * were blanked, which is the visible half, and the data behind them was not.
 *
 * It survived because `SEP` is written as a raw byte, so both lines read as a
 * space to anybody looking at them.
 */
describe("deleting a network", () => {
  const store = () => useAppStore.getState();

  beforeEach(() => {
    resetStore();
    seedStore(
      [makeNetwork("libera"), makeNetwork("oftc")],
      [makeChannel("libera", "#ctf-ops"), makeChannel("oftc", "#linux")],
      [makeQuery("oftc", "guest")],
    );
    useAppStore.setState({
      members: {
        [targetKey("oftc", "#linux")]: [
          { nick: "root", account: null, prefixes: [], away: null, realname: null },
        ],
      },
      timelines: {
        [targetKey("oftc", "#linux")]: {
          messages: [makeMessage({ id: "m1", network: "oftc", target: "#linux" })],
          unreadFrom: null, readMarker: null,
          hasMore: false,
          loadingOlder: false, askedBehind: null, detachedAt: null
        },
      },
    });
  });

  it("takes everything it owned with it", () => {
    store().applyEvent({ type: "networkRemoved", network: "oftc" });

    expect(store().channels[targetKey("oftc", "#linux")]).toBeUndefined();
    expect(store().queries[targetKey("oftc", "guest")]).toBeUndefined();
    expect(store().members[targetKey("oftc", "#linux")]).toBeUndefined();
    expect(store().timelines[targetKey("oftc", "#linux")]).toBeUndefined();
  });

  it("leaves another network's alone", () => {
    store().applyEvent({ type: "networkRemoved", network: "oftc" });

    expect(store().channels[targetKey("libera", "#ctf-ops")]).toBeTruthy();
  });

  /** A network id is a prefix of another one. Matching on the id alone would
   * take both; the separator is what stops it. */
  it("does not take a network whose id merely starts the same way", () => {
    seedStore(
      [makeNetwork("oftc"), makeNetwork("oftc-eu")],
      [makeChannel("oftc-eu", "#eu")],
    );

    store().applyEvent({ type: "networkRemoved", network: "oftc" });

    expect(store().channels[targetKey("oftc-eu", "#eu")]).toBeTruthy();
  });
});

/**
 * #321. `applyEvents` coalesces a batch's roster changes so a netsplit costs one
 * rebuild of the member list rather than one per person, which means the batch
 * path and the one-at-a-time path are two implementations of the same rule.
 * `reduce` is the one to trust; this asserts the fast one agrees with it.
 */
describe("a batch of roster changes", () => {
  const store = () => useAppStore.getState();

  function member(nick: string): Member {
    return { nick, account: null, prefixes: [], away: null, realname: null };
  }

  function seed() {
    resetStore();
    seedStore(
      [makeNetwork("libera"), makeNetwork("oftc")],
      [
        makeChannel("libera", "#ctf-ops"),
        makeChannel("libera", "#hackint"),
        makeChannel("oftc", "#linux"),
      ],
    );
    useAppStore.setState({
      members: {
        [targetKey("libera", "#ctf-ops")]: ["sable", "phrack", "nyx"].map(member),
        [targetKey("oftc", "#linux")]: ["guest", "root"].map(member),
      },
    });
  }

  /** Everything the coalescer has to get right in one batch: a channel it has
   * no roster for, a nick removed and put back, a replacement landing on top of
   * pending edits, a second network, and a `networkRemoved` in the middle —
   * which is the one other reducer that reads `members`, so the pending edits
   * have to be written back before it runs. */
  const batch: IrcxEvent[] = [
    { type: "memberRemoved", network: "libera", channel: "#ctf-ops", nick: "phrack" },
    { type: "memberUpdated", network: "libera", channel: "#ctf-ops", member: member("walker") },
    { type: "memberRemoved", network: "libera", channel: "#ctf-ops", nick: "nope" },
    { type: "memberUpdated", network: "libera", channel: "#ctf-ops", member: member("phrack") },
    { type: "memberUpdated", network: "libera", channel: "#hackint", member: member("rae") },
    { type: "memberRemoved", network: "oftc", channel: "#linux", nick: "guest" },
    {
      type: "membersReplaced",
      network: "libera",
      channel: "#ctf-ops",
      members: ["one", "two"].map(member),
    },
    { type: "memberUpdated", network: "libera", channel: "#ctf-ops", member: member("three") },
    { type: "networkRemoved", network: "oftc" },
    // A different channel from the one edited above, deliberately. Landing on
    // `#linux` would let the batch resurrect it from what it still had pending
    // and still agree with `reduce`, which is how the first version of this
    // test passed against a coalescer that never flushed before a removal.
    { type: "memberUpdated", network: "oftc", channel: "#opers", member: member("late") },
  ];

  it("lands the same members as the same events applied one at a time", () => {
    seed();
    for (const event of batch) store().applyEvent(event);
    const oneAtATime = store().members;

    seed();
    store().applyEvents(batch);

    expect(store().members).toEqual(oneAtATime);
  });

  it("keeps the order a roster was built in", () => {
    seed();
    store().applyEvents([
      { type: "memberRemoved", network: "libera", channel: "#ctf-ops", nick: "phrack" },
      { type: "memberUpdated", network: "libera", channel: "#ctf-ops", member: member("walker") },
      {
        type: "memberUpdated",
        network: "libera",
        channel: "#ctf-ops",
        member: { ...member("sable"), away: "back later" },
      },
    ]);

    // `sable` keeps its place rather than moving to the end: an update to
    // somebody already there replaces them where they are.
    expect(store().members[targetKey("libera", "#ctf-ops")]!.map((m) => m.nick)).toEqual([
      "sable",
      "nyx",
      "walker",
    ]);
  });

  it("leaves a channel nothing happened to alone, by identity", () => {
    seed();
    const before = store().members[targetKey("oftc", "#linux")];

    store().applyEvents([
      { type: "memberRemoved", network: "libera", channel: "#ctf-ops", nick: "phrack" },
    ]);

    expect(store().members[targetKey("oftc", "#linux")]).toBe(before);
  });
});

/**
 * #325. The other half of the same netsplit: `applyEvents` coalesces a batch's
 * messages so the list is extended once rather than rebuilt per event. Same
 * arrangement as the roster above — two implementations of one rule, and
 * `reduce` is the one to trust.
 */
describe("a batch of arriving messages", () => {
  const store = () => useAppStore.getState();
  const HACKINT = targetKey("libera", "#hackint");

  function said(id: string, at: string, overrides: Partial<ChatMessage> = {}) {
    return makeMessage({ id, timestamp: at, nick: "nyx", target: "#hackint", ...overrides });
  }

  function mine(id: string, at: string) {
    const message = makeMessage({ id, timestamp: at, nick: "sable" });
    message.sender.isSelf = true;
    return message;
  }

  function seed() {
    resetStore();
    seedStore(
      [makeNetwork("libera")],
      [makeChannel("libera", "#ctf-ops"), makeChannel("libera", "#hackint")],
    );
    useAppStore.setState(oneView({ network: "libera", target: "#hackint" }));
  }

  /** Everything the coalescer has to get right in one batch: a conversation it
   * holds no timeline for, an echo of a message an earlier event in the same
   * batch added, a backfill older than what is already held, an event that
   * rewrites a message only the batch is holding, and a channel closing under
   * the pane that was reading it — which is how a batch moves `activeViewId`
   * out from under the messages after it. */
  const batch: IrcxEvent[] = [
    // Arrives in the pane showing it, so it is read and leaves no seam.
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#hackint",
      messages: [said("b1", "2026-07-30T13:00:00.000Z")],
    },
    { type: "channelRemoved", network: "libera", name: "#hackint" },
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#hackint",
      messages: [said("b2", "2026-07-30T13:01:00.000Z")],
    },
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#hackint",
      messages: [said("b2", "2026-07-30T13:01:00.000Z"), said("b3", "2026-07-30T13:02:00.000Z")],
    },
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#hackint",
      messages: [said("h0", "2026-07-30T12:59:00.000Z", { source: "serverHistory" })],
    },
    {
      type: "messageUpdated",
      message: said("b3", "2026-07-30T13:02:00.000Z", { text: "edited" }),
    },
    // Nothing is showing `#ctf-ops`, and the line you sent it does not open a
    // seam — but it does not stop the answer from opening one either.
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [mine("c0", "2026-07-30T13:03:00.000Z")],
    },
    {
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [makeMessage({ id: "c1", timestamp: "2026-07-30T13:04:00.000Z" })],
    },
  ];

  it("lands the same timelines as the same events applied one at a time", () => {
    seed();
    for (const event of batch) store().applyEvent(event);
    const oneAtATime = store().timelines;

    seed();
    store().applyEvents(batch);

    expect(store().timelines).toEqual(oneAtATime);
  });

  it("puts the seam where the reader was when the message arrived", () => {
    seed();
    store().applyEvents(batch);

    // `b1` arrived while the pane was showing `#hackint`, `b2` after the close
    // took the pane off it.
    expect(store().timelines[HACKINT]?.unreadFrom).toBe("b2");
  });

  it("passes over a line you sent without letting it close the question", () => {
    seed();
    store().applyEvents(batch);

    // Deciding once at the end of the batch would read `c0` — the first live
    // message the batch brought — and stop there because it is yours, leaving
    // the answer to it unmarked.
    expect(store().timelines[targetKey("libera", "#ctf-ops")]?.unreadFrom).toBe("c1");
  });

  it("holds the messages in the order the conversation happened", () => {
    seed();
    store().applyEvents(batch);

    expect(store().timelines[HACKINT]?.messages.map((m) => m.id)).toEqual([
      "h0",
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("leaves a conversation nothing new arrived for alone, by identity", () => {
    const c1 = makeMessage({ id: "c1", timestamp: "2026-07-30T13:03:00.000Z" });
    seed();
    store().applyEvent({
      type: "messagesAppended",
      answers: null,
      network: "libera",
      target: "#ctf-ops",
      messages: [c1],
    });
    const before = store().timelines[targetKey("libera", "#ctf-ops")];

    store().applyEvents([
      {
        type: "messagesAppended",
        answers: null,
        network: "libera",
        target: "#hackint",
        messages: [said("b1", "2026-07-30T13:04:00.000Z")],
      },
      // An echo of what it already holds is not news either.
      { type: "messagesAppended", answers: null, network: "libera", target: "#ctf-ops", messages: [c1] },
    ]);

    expect(store().timelines[targetKey("libera", "#ctf-ops")]).toBe(before);
  });
});

describe("settings", () => {
  const store = () => useAppStore.getState();

  beforeEach(() => {
    resetStore();
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    store().showTarget({ network: "libera", target: "#ctf-ops" });
  });

  /** Over the layout rather than in it. The panes, which one has the focus and
   * what the next run comes back to are none of settings' business, which is
   * what a pane made them. */
  it("opens on a section and leaves the panes alone", () => {
    const layout = store().layout;
    const focused = store().activeViewId;

    store().openSettings();

    expect(store().settings).toBe("appearance");
    expect(store().layout).toBe(layout);
    expect(store().activeViewId).toBe(focused);
  });

  /** One window's worth of settings twice over is two answers to every question
   * on them. */
  it("moves to the section asked for rather than opening a second copy", () => {
    store().openSettings("plugins");

    store().openSettings("privacy");

    expect(store().settings).toBe("privacy");
  });

  /** The title bar's button and the chord both ask for no section in
   * particular, and neither means "back to the first one". */
  it("stays where it is when reopened without a section", () => {
    store().openSettings("plugins");

    store().openSettings();

    expect(store().settings).toBe("plugins");
  });

  it("closes", () => {
    store().openSettings();

    store().closeSettings();

    expect(store().settings).toBeNull();
  });
});

describe("who is ignored", () => {
  it("holds the whole set the backend sends, per network", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "ignoredChanged", network: "libera", nicks: ["spambot"] });
    applyEvent({ type: "ignoredChanged", network: "oftc", nicks: ["someone"] });

    expect(useAppStore.getState().ignored).toEqual({
      libera: ["spambot"],
      oftc: ["someone"],
    });
  });

  /** A set rather than a delta, so the later one is the answer outright — an
   * unignore arrives as a shorter list, not as a removal. */
  it("replaces rather than merging", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "ignoredChanged", network: "libera", nicks: ["spambot", "otherbot"] });
    applyEvent({ type: "ignoredChanged", network: "libera", nicks: ["otherbot"] });

    expect(useAppStore.getState().ignored.libera).toEqual(["otherbot"]);
  });
});

describe("files moving", () => {
  function transfer(over: Partial<Transfer> = {}): Transfer {
    return {
      id: "t1",
      network: "libera",
      peer: "sable",
      direction: "incoming",
      file: "holiday.png",
      path: null,
      size: 51_200n,
      at: 0n,
      state: "offered",
      failure: null,
      started: "2026-08-26T10:00:00Z",
      message: "m1",
      ...over,
    };
  }

  /** Every update carries the whole transfer, progress included, so the last
   * to arrive is the answer and nothing has to be merged into what is held. */
  it("keeps the latest state of each one", () => {
    const { applyEvent } = useAppStore.getState();
    applyEvent({ type: "transferUpdated", transfer: transfer() });
    applyEvent({ type: "transferUpdated", transfer: transfer({ state: "running", at: 2048n }) });
    applyEvent({ type: "transferUpdated", transfer: transfer({ id: "t2", peer: "hex" }) });

    const held = useAppStore.getState().transfers;
    expect(Object.keys(held).sort()).toEqual(["t1", "t2"]);
    expect(held.t1?.state).toBe("running");
    expect(held.t1?.at).toBe(2048n);
    expect(held.t2?.peer).toBe("hex");
  });
});
