import { ipc, onIrcxEvent } from "@/lib/ipc";
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
    if (loaded) useAppStore.getState().applyEvents(events);
    else held.push(...events);
  });

  try {
    await loadSnapshot();
  } finally {
    loaded = true;
    useAppStore.getState().applyEvents(held);
    held.length = 0;
  }

  return () => {
    stopFollowingFocus();
    unlisten();
  };
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
  let last: string | null = null;

  return useAppStore.subscribe((state) => {
    const view = state.activeViewId ? state.views[state.activeViewId] : undefined;
    if (!view || !view.network || view.target === "") return;

    const at = targetKey(view.network, view.target);
    if (at === last) return;
    last = at;
    // `mark_read` is `tell_if_connected`, so a conversation with no session
    // costs nothing and cannot fail in a way the user sees.
    void ipc.markRead(view.network, view.target).catch(() => {});
  });
}

/** The snapshot is the same state the events describe, so it goes in as
 * events: networks first, then the targets that hang off them. */
async function loadSnapshot(): Promise<void> {
  const snapshot = await ipc.getSnapshot();
  const { applyEvent } = useAppStore.getState();

  for (const network of snapshot.networks) applyEvent({ type: "networkUpdated", network });
  for (const channel of snapshot.channels) applyEvent({ type: "channelUpdated", channel });
  for (const query of snapshot.queries) applyEvent({ type: "queryUpdated", query });

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
