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
  sanitiseNotifications,
  worthNotifying,
  type Notifications,
} from "./notifications";

const BOTH: Notifications = { highlights: true, directMessages: true };

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

  it("obeys each switch on its own", () => {
    const mention = makeMessage({ nick: "phrack", text: "sable: ping" });
    const dm = makeMessage({ nick: "buildbot", text: "deploy finished" });
    const onlyDms: Notifications = { highlights: false, directMessages: true };

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
});

describe("the stored switches", () => {
  it("start off, because interrupting somebody is theirs to ask for", () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({ highlights: false, directMessages: false });
  });

  it("keep the field that was written and fall back on the one that was not", () => {
    expect(sanitiseNotifications({ highlights: true, directMessages: "yes" })).toEqual({
      highlights: true,
      directMessages: false,
    });
    expect(sanitiseNotifications("nonsense")).toEqual(DEFAULT_NOTIFICATIONS);
    expect(sanitiseNotifications(null)).toEqual(DEFAULT_NOTIFICATIONS);
  });
});
