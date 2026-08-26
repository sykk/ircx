import { getCurrentWindow } from "@tauri-apps/api/window";
import { insideTauri, ipc, onIrcxEvent } from "@/lib/ipc";
import { notifyForEvents } from "@/lib/notifications";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { IrcxEvent } from "@/types";

/**
 * Connects the store to the backend: subscribe first, then load the opening
 * snapshot. Events that arrive while the snapshot is in flight are held back,
 * because the snapshot describes an older moment and would undo them.
 *
 * Resolves to an unsubscribe function.
 */
export async function startBridge(): Promise<() => void> {
  const held: IrcxEvent[] = [];
  let loaded = false;
  const stopFollowingFocus = followFocus();

  const unlisten = await onIrcxEvent((events) => {
    if (loaded) {
      useAppStore.getState().applyEvents(events);
      // After the store has taken them, so what is muted and what is on screen
      // are asked of the state the reader is looking at rather than the one
      // before this batch.
      notifyForEvents(events);
    } else held.push(...events);
  });

  const stop = () => {
    stopFollowingFocus();
    unlisten();
  };

  try {
    await loadSnapshot();
  } catch (reason) {
    // Undone before this is re-thrown. The subscription is already live by
    // here, and a caller that never receives `stop` cannot take it down: a
    // failed start used to leave a listener and a focus follower running for
    // the rest of the launch, which also made trying again cost a second set
    // of both.
    stop();
    throw reason;
  } finally {
    loaded = true;
    // The held events are what arrived while the snapshot was in flight, which
    // is the first fraction of a second of a launch. Applied, and deliberately
    // not notified for: a client that has just started has not been away, and
    // a burst of notifications for a conversation being drawn for the first
    // time is the launch itself interrupting somebody.
    useAppStore.getState().applyEvents(held);
    held.length = 0;
  }

  return stop;
}

/**
 * Tells the backend a conversation has been read when the pane showing it takes
 * focus.
 *
 * `mark_read` is the only thing that resets a conversation's unread count, and
 * until #133 nothing called it — so a badge in the sidebar only ever grew. The
 * timeline's unread rule is separate and always did clear on a switch, which is
 * why the number beside the channel could stay wrong without anybody noticing.
 *
 * Focus rather than merely being on screen: a channel sitting in the other half
 * of a split is not one the user is reading.
 */
function followFocus(): () => void {
  const appWindow = insideTauri() ? getCurrentWindow() : null;
  let focused = appWindow === null;
  let lastTarget: string | null = null;
  let lastUnread = 0;
  let stopped = false;
  let stopWindow = () => {};

  const markCurrent = (force = false) => {
    const state = useAppStore.getState();
    const view = state.activeViewId ? state.views[state.activeViewId] : undefined;
    if (!view || !view.network || view.target === "") {
      lastTarget = null;
      lastUnread = 0;
      return;
    }

    const at = targetKey(view.network, view.target);
    const unread = state.channels[at]?.unread ?? state.queries[at]?.unread ?? 0;
    const moved = at !== lastTarget;
    const grew = !moved && unread > lastUnread;
    lastTarget = at;
    lastUnread = unread;
    if (!focused || (!force && !moved && !grew)) return;

    // `mark_read` is `tell_if_connected`, so a conversation with no session
    // costs nothing and cannot fail in a way the user sees.
    void ipc.markRead(view.network, view.target).catch(() => {});
  };

  const stopStore = useAppStore.subscribe(() => markCurrent());
  if (appWindow !== null) {
    let focusVersion = 0;
    void (async () => {
      try {
        const unlisten = await appWindow.onFocusChanged(({ payload }) => {
          if (stopped) return;
          focusVersion += 1;
          focused = payload;
          if (focused) markCurrent(true);
        });
        if (stopped) {
          unlisten();
          return;
        }
        stopWindow = unlisten;

        const versionBeforeQuery = focusVersion;
        const initiallyFocused = await appWindow.isFocused();
        if (stopped || focusVersion !== versionBeforeQuery) return;
        focused = initiallyFocused;
        if (focused) markCurrent(true);
      } catch (reason) {
        focused = false;
        if (stopped) return;
        console.warn("ircx could not follow whether its window has focus", reason);
      }
    })();
  }

  return () => {
    stopped = true;
    stopStore();
    stopWindow();
  };
}

/** The snapshot is the same state the events describe, so it goes in as
 * events: networks first, then the targets that hang off them. */
async function loadSnapshot(): Promise<void> {
  const [snapshot, bookmarks, transfers] = await Promise.all([
    ipc.getSnapshot(),
    // Answered with nothing rather than failing, for the reason the transfers
    // below are: a conversation is not worth losing over the marks somebody
    // put on it. `get_snapshot` is the exception and stays fatal — it is the
    // networks, the channels and the queries, which is the client itself.
    ipc.listBookmarks(null, null, 10_000).catch((reason: unknown) => {
      console.warn("ircx could not read the bookmarks", reason);
      return [];
    }),
    // Not part of the snapshot: a transfer is a live connection rather than
    // state a conversation has, and it outlives a reload of this window while
    // the events describing it do not.
    //
    // Answered with nothing rather than failing, because this is the least of
    // the three and the other two are the client itself. Awaited beside them it
    // could empty the whole window — every network, channel and query gone —
    // over a list that is usually empty. #645 shipped it that way and the
    // harness, which has no handler for it, came up saying no networks were
    // configured.
    ipc.listTransfers().catch((reason: unknown) => {
      console.warn("ircx could not list the transfers in flight", reason);
      return [];
    }),
  ]);
  const { applyEvent } = useAppStore.getState();

  for (const network of snapshot.networks) applyEvent({ type: "networkUpdated", network });
  for (const channel of snapshot.channels) applyEvent({ type: "channelUpdated", channel });
  for (const query of snapshot.queries) applyEvent({ type: "queryUpdated", query });
  for (const transfer of transfers) applyEvent({ type: "transferUpdated", transfer });
  for (const draft of snapshot.drafts) {
    useAppStore.getState().setDraftPresence(draft.network, draft.target, true);
  }
  for (const hit of bookmarks) {
    useAppStore.getState().setBookmarked(
      hit.message.network,
      hit.message.target,
      hit.message.id,
      true,
    );
  }

  // Member lists are not part of the snapshot. Without this a reload while
  // connected leaves the drawer empty until the next NAMES.
  await Promise.all(
    snapshot.channels
      .filter((channel) => channel.joined)
      .map(async ({ network, name }) => {
        try {
          const members = await ipc.listMembers(network, name);
          applyEvent({ type: "membersReplaced", network, channel: name, members });
        } catch (reason) {
          // The channel still renders; the next NAMES fills the list in.
          console.warn(`ircx could not list the members of ${name}`, reason);
        }
      }),
  );
}
