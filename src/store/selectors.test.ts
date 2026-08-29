import { readFileSync } from "node:fs";
import { renderHook, act } from "@testing-library/react";
import { useAppStore } from "./index";
import {
  useActiveTarget,
  useChannelsFor,
  useMembers,
  useNetworks,
  useQueriesFor,
  isHighlight,
  isHushed,
  selectConversationNames,
  selectQueued,
  matchesHighlight,
  splitOnHighlight,
  targetKey,
  NO_HIGHLIGHT,
  type HighlightRule,
} from "./selectors";
import { makeMessage } from "@/components/timeline/fixtures";
import type { ChatView } from "./types";
import type { Channel, ChatMessage, Network, Query } from "@/types";

function network(id: string): Network {
  return {
    id,
    name: id,
    host: `irc.${id}.net`,
    port: 6697,
    tls: true,
    status: { state: "connected" },
    configuredNick: "sable",
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
    muted: false,
  };
}

function query(net: string, nick: string): Query {
  return { network: net, nick, account: null, unread: 0, online: true, muted: false };
}

function view(id: string, network: string, target: string): ChatView {
  return { id, network, target, selectedUser: null, raw: false };
}

/** Two panes on one target, which no action opens yet — splits land in the next
 * issue and the model has to hold them before the UI can. */
function seedViews(...views: ChatView[]) {
  useAppStore.setState({
    views: Object.fromEntries(views.map((v) => [v.id, v])),
    viewOrder: views.map((v) => v.id),
    activeViewId: views[0]?.id ?? null,
    layout: views[0] ? { type: "view", id: views[0].id } : null,
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
    layout: null,
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
  it("reads two views on one target independently", () => {
    seedViews(view("a", "libera", "#ctf-ops"), view("b", "libera", "#ctf-ops"));

    const { setViewAnchor } = useAppStore.getState();
    setViewAnchor("a", "row-old");
    setViewAnchor("b", "row-recent");

    const { viewAnchor } = useAppStore.getState();
    expect(viewAnchor.a).toBe("row-old");
    expect(viewAnchor.b).toBe("row-recent");
  });

  it("resets the reading position and the inspector when a view is retargeted", () => {
    seedViews(view("a", "libera", "#ctf-ops"));

    const store = useAppStore.getState();
    store.setViewAnchor("a", "row-old");
    store.setViewSelectedUser("a", "phrack");
    store.setActive({ network: "libera", target: "#hackint" });

    expect(useAppStore.getState().views.a).toEqual({
      id: "a",
      network: "libera",
      target: "#hackint",
      selectedUser: null,
      raw: false,
    });
    expect(useAppStore.getState().viewAnchor.a).toBe(null);
  });

  it("leaves the other view alone when one is retargeted", () => {
    seedViews(view("a", "libera", "#ctf-ops"), view("b", "libera", "#ctf-ops"));
    useAppStore.getState().setViewAnchor("b", "row-recent");

    useAppStore.getState().setActive({ network: "libera", target: "#hackint" });

    expect(useAppStore.getState().views.b).toEqual(view("b", "libera", "#ctf-ops"));
    expect(useAppStore.getState().viewAnchor.b).toBe("row-recent");
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
    useAppStore.getState().setViewAnchor("a", "row-old");

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

describe("splitting", () => {
  it("opens a second pane on the same target and focuses it", () => {
    seedViews(view("a", "libera", "#ctf-ops"));

    useAppStore.getState().splitActiveView("row");

    const { views, viewOrder, activeViewId, layout } = useAppStore.getState();
    expect(viewOrder).toHaveLength(2);
    expect(activeViewId).toBe(viewOrder[1]);
    expect(views[activeViewId!]).toMatchObject({
      network: "libera",
      target: "#ctf-ops",
    });
    expect(layout).toEqual({
      type: "split",
      direction: "row",
      children: [
        { type: "view", id: "a" },
        { type: "view", id: viewOrder[1] },
      ],
    });
  });

  it("splits the focused pane without rearranging the others", () => {
    seedViews(view("a", "libera", "#ctf-ops"));
    const store = useAppStore.getState();

    store.splitActiveView("row");
    const second = useAppStore.getState().activeViewId!;
    store.focusView("a");
    store.splitActiveView("column");

    const { viewOrder, layout } = useAppStore.getState();
    expect(viewOrder).toEqual(["a", viewOrder[1], second]);
    expect(layout).toMatchObject({
      direction: "row",
      children: [{ direction: "column" }, { type: "view", id: second }],
    });
  });

  it("collapses the split when a pane closes and focuses a neighbour", () => {
    seedViews(view("a", "libera", "#ctf-ops"));
    useAppStore.getState().splitActiveView("row");
    const second = useAppStore.getState().activeViewId!;

    useAppStore.getState().closeView(second);

    const { views, viewOrder, activeViewId, layout } = useAppStore.getState();
    expect(Object.keys(views)).toEqual(["a"]);
    expect(viewOrder).toEqual(["a"]);
    expect(activeViewId).toBe("a");
    expect(layout).toEqual({ type: "view", id: "a" });
  });

  it("leaves focus alone when the pane that closed was not the focused one", () => {
    seedViews(view("a", "libera", "#ctf-ops"));
    useAppStore.getState().splitActiveView("row");
    const second = useAppStore.getState().activeViewId!;

    useAppStore.getState().closeView("a");

    expect(useAppStore.getState().activeViewId).toBe(second);
  });

  it("refuses to close the last pane", () => {
    seedViews(view("a", "libera", "#ctf-ops"));

    useAppStore.getState().closeView("a");

    const { views, viewOrder, activeViewId } = useAppStore.getState();
    expect(viewOrder).toEqual(["a"]);
    expect(activeViewId).toBe("a");
    expect(views.a).toBeTruthy();
  });

  it("points one pane somewhere else without moving the other", () => {
    seedViews(view("a", "libera", "#ctf-ops"));
    const store = useAppStore.getState();
    store.splitActiveView("row");
    const second = useAppStore.getState().activeViewId!;

    store.setActive({ network: "libera", target: "#hackint" });

    const { views } = useAppStore.getState();
    expect(views[second]).toMatchObject({ target: "#hackint" });
    expect(views.a).toMatchObject({ target: "#ctf-ops" });
  });
});

/** The rule as a nick and nothing beside it, which is what these cases are
 * about. */
const rule = (nick: string): HighlightRule => ({ nick, words: [], hushed: [] });

describe("a hushed sender", () => {
  const line = (nick: string, text: string) => makeMessage({ nick, text });
  const rule: HighlightRule = { nick: "syk", words: ["deploy"], hushed: ["ci-bot"] };

  it("does not make a line loud by naming the reader", () => {
    expect(isHighlight(line("ci-bot", "syk: the build failed"), rule)).toBe(false);
  });

  it("does not make one loud with a word either", () => {
    expect(isHighlight(line("ci-bot", "the deploy finished"), rule)).toBe(false);
  });

  it("leaves everybody else alone", () => {
    expect(isHighlight(line("sable", "syk: the build failed"), rule)).toBe(true);
  });

  /* Hushing decides loudness and nothing else — the words are still in the
   * message, so the row draws and the unread count still moves. */
  it("keeps the line, which is what separates it from an ignore", () => {
    expect(line("ci-bot", "syk: the build failed").text).toBe("syk: the build failed");
  });
});

describe("the shared hushed cases", () => {
  /** The second rule `fixtures/highlight.json` holds both languages to. A
   * sender the reader hushed never raises them, and the two implementations of
   * that must not drift apart any more than the two of `raises` may. */
  const fixture = JSON.parse(readFileSync("fixtures/highlight.json", "utf8")) as {
    hushedCases: { why: string; sender: string; hushed: string[]; hushes: boolean }[];
  };

  it.each(fixture.hushedCases)("$why", ({ sender, hushed, hushes }) => {
    expect(isHushed(sender, { nick: "syk", words: [], hushed })).toBe(hushes);
  });
});

describe("the shared highlight cases", () => {
  /** The same file `crates/ircx-core/src/text.rs` reads, and the reason both
   * can be trusted to agree: the backend counts the badge and this decides the
   * tint, so a case either language has not learned shows up as a channel that
   * went loud with nothing marked in it. Read rather than imported, because it
   * belongs to neither side and lives outside `src`. Read from the repo root,
   * which is where vitest runs. */
  const fixture = JSON.parse(readFileSync("fixtures/highlight.json", "utf8")) as { cases: { why: string; text: string; nick: string; words: string[]; raises: boolean }[] };

  it.each(fixture.cases)("$why", ({ text, nick, words, raises }) => {
    expect(matchesHighlight(text, { nick, words, hushed: [] })).toBe(raises);
  });
});

describe("matchesHighlight", () => {
  it("matches on word boundaries, not substrings", () => {
    expect(matchesHighlight("sable: ping", rule("sable"))).toBe(true);
    expect(matchesHighlight("hey sable", rule("sable"))).toBe(true);
    expect(matchesHighlight("sableton is here", rule("sable"))).toBe(false);
    expect(matchesHighlight("unsable", rule("sable"))).toBe(false);
  });

  it("treats the IRC nick punctuation set as part of the nick", () => {
    expect(matchesHighlight("hi [dev]", rule("[dev]"))).toBe(true);
    expect(matchesHighlight("re: a|b done", rule("a|b"))).toBe(true);
  });

  it("ignores case and an empty nick", () => {
    expect(matchesHighlight("SABLE: hi", rule("sable"))).toBe(true);
    expect(matchesHighlight("anything", rule(""))).toBe(false);
  });
});

describe("splitOnHighlight", () => {
  const marked = (runs: { text: string; mine: boolean }[]) =>
    runs.filter((run) => run.mine).map((run) => run.text);

  it("picks the nick out and leaves the rest of the line whole", () => {
    expect(splitOnHighlight("hey sable, look", rule("sable"))).toEqual([
      { text: "hey ", mine: false },
      { text: "sable", mine: true },
      { text: ", look", mine: false },
    ]);
  });

  /** The trailing boundary is a lookahead for this: consumed, it became the
   * leading boundary the second occurrence needed and only the first matched. */
  it("finds every occurrence, including two in a row", () => {
    expect(marked(splitOnHighlight("sable sable", rule("sable")))).toEqual(["sable", "sable"]);
  });

  it("keeps the casing the sender typed rather than the reader's own", () => {
    expect(marked(splitOnHighlight("SABLE: hi", rule("sable")))).toEqual(["SABLE"]);
  });

  it("marks nothing when the nick is absent, a substring, or unknown", () => {
    expect(marked(splitOnHighlight("sableton is here", rule("sable")))).toEqual([]);
    expect(marked(splitOnHighlight("nothing here", rule("sable")))).toEqual([]);
    expect(marked(splitOnHighlight("hey sable", NO_HIGHLIGHT))).toEqual([]);
  });

  // Drawn and decided by one pattern. A row tinted with nothing picked out in
  // it, or a word picked out in a row that was never tinted, is the drift this
  // rules out.
  it("agrees with matchesHighlight about what counts as one", () => {
    for (const text of ["sable: ping", "hey sable", "sableton is here", "unsable", "hi [dev]"]) {
      for (const nick of ["sable", "[dev]"]) {
        expect(marked(splitOnHighlight(text, rule(nick))).length > 0).toBe(
          matchesHighlight(text, rule(nick)),
        );
      }
    }
  });

  it("marks a word the reader added, not only their nick", () => {
    expect(marked(splitOnHighlight("the deploy went out", { nick: "sable", words: ["deploy"], hushed: [] })))
      .toEqual(["deploy"]);
  });

  /** Longest first in the alternation, so the line is not marked twice over. */
  it("marks the longer of two words that share a prefix", () => {
    expect(
      marked(splitOnHighlight("the deployment stalled", { nick: "sable", words: ["deploy", "deployment"], hushed: [] })),
    ).toEqual(["deployment"]);
  });
});

/**
 * #222. Ergo replays a channel's comings and goings as ordinary messages from
 * `HistServ`, so the line that says the reader joined is a message whose text
 * holds the reader's own name.
 */
describe("who can address you", () => {
  const from = (nick: string, text: string) => makeMessage({ nick, text });

  it("marks somebody in the conversation naming you", () => {
    expect(isHighlight(from("phrack", "sable: look at this"), rule("sable"), new Set(["phrack"]))).toBe(
      true,
    );
  });

  it("does not mark a service that is not in it", () => {
    expect(
      isHighlight(from("HistServ", "sable joined the channel"), rule("sable"), new Set(["phrack"])),
    ).toBe(false);
  });

  it("folds the roster, because a server may answer in another casing", () => {
    expect(isHighlight(from("Phrack", "sable: hi"), rule("sable"), new Set(["phrack"]))).toBe(true);
  });

  /** A roster that has not arrived is not a channel nobody is in: the reader is
   * always in their own. */
  it("does not gate on an empty roster", () => {
    expect(isHighlight(from("phrack", "sable: hi"), rule("sable"), new Set())).toBe(true);
  });

  /** A query has no roster to check, and the only two people who can speak in
   * one are its two ends. */
  it("does not gate when no roster is given", () => {
    expect(isHighlight(from("phrack", "sable: hi"), rule("sable"))).toBe(true);
  });

  it("still ignores your own messages", () => {
    const own = makeMessage({ nick: "sable", text: "sable" });
    own.sender.isSelf = true;
    expect(isHighlight(own, rule("sable"), new Set(["sable"]))).toBe(false);
  });
});

describe("what is still waiting to send", () => {
  function ours(id: string, delivery: ChatMessage["delivery"]): ChatMessage {
    const message = makeMessage({ id, nick: "sable", delivery });
    message.sender.isSelf = true;
    return message;
  }

  function theirs(id: string): ChatMessage {
    return makeMessage({ id, nick: "phrack" });
  }

  function hold(...messages: ChatMessage[]) {
    useAppStore.setState({
      timelines: {
        [targetKey("libera", "#ctf-ops")]: {
          messages,
          unreadFrom: null, readMarker: null,
          hasMore: false,
          loadingOlder: false, askedBehind: null, detachedAt: null
        },
      },
    });
  }

  const count = () => selectQueued(useAppStore.getState(), "libera", "#ctf-ops");

  it("is nothing in a conversation nobody has typed into", () => {
    hold(theirs("a"), theirs("b"));
    expect(count()).toBe(0);
  });

  it("is nothing when the last thing we said has left", () => {
    hold(ours("a", { state: "sent" }), ours("b", { state: "delivered" }));
    expect(count()).toBe(0);
  });

  it("counts the run of ours still queued", () => {
    hold(
      ours("a", { state: "delivered" }),
      ours("b", { state: "pending" }),
      ours("c", { state: "pending" }),
    );
    expect(count()).toBe(2);
  });

  /** The case a paste is actually walked in: the channel goes on talking while
   * ours drains, so somebody else's line lands between two of ours. Counting
   * has to step over it rather than stop, which is the difference between this
   * and reading backwards to the first message that is not pending. */
  it("steps over what other people said in the middle of it", () => {
    hold(
      ours("a", { state: "pending" }),
      theirs("b"),
      ours("c", { state: "pending" }),
      theirs("d"),
    );
    expect(count()).toBe(2);
  });

  /** A line of ours that was refused ends the queue behind it. Everything we
   * sent before one that came back has been written, because the writer writes
   * in the order it was given and #334 settles them in that order too. */
  it("stops at a line of ours that did not make it", () => {
    hold(
      ours("a", { state: "pending" }),
      ours("b", { state: "failed", detail: "Cannot send to channel" }),
      ours("c", { state: "pending" }),
    );
    expect(count()).toBe(1);
  });
});

describe("the conversations a plugin can be handed", () => {
  function names(channels: Channel[], queries: Query[] = []): string[] {
    return selectConversationNames({
      channels: Object.fromEntries(channels.map((c) => [targetKey(c.network, c.name), c])),
      queries: Object.fromEntries(queries.map((q) => [targetKey(q.network, q.nick), q])),
    });
  }

  it("puts the channels before the queries and sorts each by name", () => {
    expect(
      names(
        [channel("libera", "#rust"), channel("libera", "#ircx")],
        [query("libera", "sable"), query("libera", "phrack")],
      ),
    ).toEqual(["#ircx", "#rust", "phrack", "sable"]);
  });

  /** A grant holds a name and no network, so two networks with the same channel
   * are one row to tick and one grant reaching both. A second row would be a
   * tick that changed nothing. */
  it("draws one row for a name that is on two networks", () => {
    expect(names([channel("libera", "#ircx"), channel("oftc", "#ircx")])).toEqual(["#ircx"]);
  });

  /** A reconnect leaves every channel unjoined until it comes back. Offering
   * only the joined ones would empty this list while the sidebar still drew
   * them, and refuse a grant for a reason nobody could see. */
  it("offers a channel whose network is still coming back", () => {
    expect(names([{ ...channel("libera", "#ircx"), joined: false }])).toEqual(["#ircx"]);
  });
});
