import { beforeEach, describe, expect, it } from "vitest";
import {
  makeChannel,
  makeNetwork,
  makeQuery,
  resetStore,
  seedStore,
} from "@/components/shell/fixtures";
import { makeMessage } from "@/components/timeline/fixtures";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { ChatMessage, IrcxEvent } from "@/types";
import {
  DEFAULT_NOTIFICATIONS,
  isQuietAt,
  sanitiseNotifications,
  watchNotification,
  worthNotifying,
  type Notifications,
} from "./notifications";

const BOTH: Notifications = {
  highlights: true,
  directMessages: true,
  quietHours: null,
  conversations: {},
  watchPresence: false,
};

type Appended = Extract<IrcxEvent, { type: "messagesAppended" }>;

function appended(target: string, message: ChatMessage): Appended {
  return { type: "messagesAppended", answers: null, network: "libera", target, messages: [message] };
}

/** The reader is `sable`, in one channel and one query, looking at neither. */
beforeEach(() => {
  resetStore();
  seedStore(
    [makeNetwork("libera", { currentNick: "sable" })],
    [makeChannel("libera", "#ircx")],
    [makeQuery("libera", "buildbot")],
  );
});

/** Points the focused pane at a conversation, as clicking it would. */
function looking(target: string) {
  useAppStore.getState().setActive({ network: "libera", target });
}

describe("what is worth a notification", () => {
  it("raises for a mention in a channel, naming where it was said", () => {
    const worth = worthNotifying(
      appended("#ircx", makeMessage({ nick: "phrack", text: "sable: have a look" })),
      makeMessage({ nick: "phrack", text: "sable: have a look" }),
      BOTH,
      false,
    );

    expect(worth).toEqual({ title: "phrack in #ircx", body: "sable: have a look" });
  });

  it("stays quiet for a channel line that mentions nobody", () => {
    const message = makeMessage({ nick: "phrack", text: "the build is green" });

    expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toBeNull();
  });

  /** A query carries no keyword and needs none: somebody opened a conversation
   * with the reader and nobody else. */
  it("raises for any line in a query", () => {
    const message = makeMessage({ nick: "buildbot", text: "deploy finished" });

    expect(worthNotifying(appended("buildbot", message), message, BOTH, false)).toEqual({
      title: "buildbot",
      body: "deploy finished",
    });
  });

  /* The half a highlight rule alone never reached. A service notices you, a
   * query opens, and that query notifies on `directMessages` rather than on
   * anything the text said — so hushing has to be asked before the split. */
  describe("a hushed sender", () => {
    beforeEach(() => {
      useAppStore.getState().setHushedNicks(["buildbot", "NickServ"]);
    });

    it("raises nothing in a query, which no keyword gated", () => {
      const message = makeMessage({ nick: "buildbot", text: "deploy finished" });

      expect(worthNotifying(appended("buildbot", message), message, BOTH, false)).toBeNull();
    });

    it("raises nothing by naming the reader in a channel", () => {
      const message = makeMessage({ nick: "buildbot", text: "sable: have a look" });

      expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toBeNull();
    });

    it("is folded, because nobody types a service's name the way it registered", () => {
      const message = makeMessage({ nick: "nickserv", text: "sable: you are identified" });

      expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toBeNull();
    });

    /* Above the per-conversation setting on purpose: the list is a statement
     * about a person, and "every live message" is one about a conversation. */
    it("stays quiet even where the conversation asked for every message", () => {
      const message = makeMessage({ nick: "buildbot", text: "deploy finished" });
      const every: Notifications = {
        ...BOTH,
        conversations: { [targetKey("libera", "buildbot")]: "all" },
      };

      expect(worthNotifying(appended("buildbot", message), message, every, false)).toBeNull();
    });

    it("leaves everybody else alone", () => {
      const message = makeMessage({ nick: "phrack", text: "sable: have a look" });

      expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toEqual({
        title: "phrack in #ircx",
        body: "sable: have a look",
      });
    });
  });

  it("obeys each switch on its own", () => {
    const mention = makeMessage({ nick: "phrack", text: "sable: ping" });
    const dm = makeMessage({ nick: "buildbot", text: "deploy finished" });
    const onlyDms: Notifications = { ...BOTH, highlights: false };

    expect(worthNotifying(appended("#ircx", mention), mention, onlyDms, false)).toBeNull();
    expect(worthNotifying(appended("buildbot", dm), dm, onlyDms, false)).not.toBeNull();
  });

  it("never raises for the reader's own line", () => {
    const own = makeMessage({ nick: "sable", text: "sable: talking to myself" });
    own.sender.isSelf = true;

    expect(worthNotifying(appended("#ircx", own), own, BOTH, false)).toBeNull();
  });

  /** The whole reason the rule takes focus: a notification for the line
   * somebody just watched arrive is the fastest way to get the feature turned
   * off. */
  it("stays quiet for the conversation being looked at in a focused window", () => {
    looking("#ircx");
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });

    expect(worthNotifying(appended("#ircx", message), message, BOTH, true)).toBeNull();
  });

  it("raises for that conversation once the window loses focus", () => {
    looking("#ircx");
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });

    expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).not.toBeNull();
  });

  it("raises for a conversation other than the one being looked at", () => {
    looking("buildbot");
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });

    expect(worthNotifying(appended("#ircx", message), message, BOTH, true)).not.toBeNull();
  });

  it("stays quiet for a muted conversation", () => {
    useAppStore.setState((s) => ({
      channels: {
        ...s.channels,
        [targetKey("libera", "#ircx")]: makeChannel("libera", "#ircx", { muted: true }),
      },
    }));
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });

    expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toBeNull();
  });

  it("stays quiet for a muted query", () => {
    useAppStore.setState((s) => ({
      queries: {
        ...s.queries,
        [targetKey("libera", "buildbot")]: makeQuery("libera", "buildbot", { muted: true }),
      },
    }));
    const message = makeMessage({ nick: "buildbot", text: "deploy finished" });

    expect(worthNotifying(appended("buildbot", message), message, BOTH, false)).toBeNull();
  });

  /** A backfill already happened and the reader asked to see it, which is the
   * rule a notification plugin is held to as well. */
  it("stays quiet for replayed history", () => {
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });
    message.source = "serverHistory";

    expect(worthNotifying(appended("#ircx", message), message, BOTH, false)).toBeNull();
  });

  /** The server console is the network talking, not a person, and it is not a
   * conversation anybody can be addressed in. */
  it("stays quiet for the server console", () => {
    const message = makeMessage({ nick: "irc.libera.chat", text: "sable: welcome" });

    expect(worthNotifying(appended("", message), message, BOTH, false)).toBeNull();
  });

  it("lets one conversation raise every live message", () => {
    const message = makeMessage({ nick: "phrack", text: "the build is green" });
    const settings = {
      ...BOTH,
      highlights: false,
      conversations: { [targetKey("libera", "#ircx")]: "all" as const },
    };

    expect(worthNotifying(appended("#ircx", message), message, settings, false)).toEqual({
      title: "phrack in #ircx",
      body: "the build is green",
    });
  });

  it("can keep one conversation to highlights or mute it", () => {
    const ordinary = makeMessage({ nick: "phrack", text: "the build is green" });
    const mention = makeMessage({ nick: "phrack", text: "sable: the build is green" });
    const key = targetKey("libera", "#ircx");

    expect(
      worthNotifying(
        appended("#ircx", ordinary),
        ordinary,
        { ...BOTH, conversations: { [key]: "highlights" } },
        false,
      ),
    ).toBeNull();
    expect(
      worthNotifying(
        appended("#ircx", mention),
        mention,
        { ...BOTH, conversations: { [key]: "highlights" } },
        false,
      ),
    ).not.toBeNull();
    expect(
      worthNotifying(
        appended("#ircx", mention),
        mention,
        { ...BOTH, conversations: { [key]: "mute" } },
        false,
      ),
    ).toBeNull();
  });

  it("suppresses desktop notifications during quiet hours only", () => {
    const message = makeMessage({ nick: "phrack", text: "sable: ping" });
    const settings = { ...BOTH, quietHours: { start: "22:00", end: "07:00" } };

    expect(
      worthNotifying(appended("#ircx", message), message, settings, false, new Date(2026, 0, 1, 23)),
    ).toBeNull();
    expect(useAppStore.getState().channels[targetKey("libera", "#ircx")]?.unread).toBe(0);
  });
});

describe("quiet hours", () => {
  const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute);

  it("handles a range that crosses midnight", () => {
    const quiet = { start: "22:00", end: "07:00" };
    expect(isQuietAt(quiet, at(21, 59))).toBe(false);
    expect(isQuietAt(quiet, at(22))).toBe(true);
    expect(isQuietAt(quiet, at(0))).toBe(true);
    expect(isQuietAt(quiet, at(6, 59))).toBe(true);
    expect(isQuietAt(quiet, at(7))).toBe(false);
  });

  it("handles a daytime range and treats equal endpoints as disabled", () => {
    expect(isQuietAt({ start: "09:00", end: "17:00" }, at(9))).toBe(true);
    expect(isQuietAt({ start: "09:00", end: "17:00" }, at(17))).toBe(false);
    expect(isQuietAt({ start: "00:00", end: "00:00" }, at(12))).toBe(false);
  });
});

describe("watched nick notifications", () => {
  const event: Extract<IrcxEvent, { type: "notice" }> = {
    type: "notice",
    network: "libera",
    severity: "info",
    text: "sable is online",
    detail: "ircx-watch-online:sable",
  };

  it("is opt-in and obeys quiet hours", () => {
    expect(watchNotification(event, BOTH, new Date(2026, 0, 1, 12))).toBeNull();
    expect(
      watchNotification(
        event,
        { ...BOTH, watchPresence: true },
        new Date(2026, 0, 1, 12),
      ),
    ).toEqual({ title: "sable is online", body: "libera" });
    expect(
      watchNotification(
        event,
        { ...BOTH, watchPresence: true, quietHours: { start: "22:00", end: "07:00" } },
        new Date(2026, 0, 1, 23),
      ),
    ).toBeNull();
  });
});

describe("the stored switches", () => {
  it("start off, because interrupting somebody is theirs to ask for", () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({
      highlights: false,
      directMessages: false,
      quietHours: null,
      conversations: {},
      watchPresence: false,
    });
  });

  it("keep the field that was written and fall back on the one that was not", () => {
    expect(sanitiseNotifications({ highlights: true, directMessages: "yes" })).toEqual({
      highlights: true,
      directMessages: false,
      quietHours: null,
      conversations: {},
      watchPresence: false,
    });
    expect(sanitiseNotifications("nonsense")).toEqual(DEFAULT_NOTIFICATIONS);
    expect(sanitiseNotifications(null)).toEqual(DEFAULT_NOTIFICATIONS);
  });

  it("drops malformed quiet hours and conversation modes field by field", () => {
    expect(
      sanitiseNotifications({
        quietHours: { start: "22:00", end: "31:00" },
        conversations: { good: "all", bad: "sometimes" },
        watchPresence: true,
      }),
    ).toMatchObject({ quietHours: null, conversations: { good: "all" }, watchPresence: true });
  });
});
