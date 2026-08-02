import { useAppStore, type AppActions } from "@/store";
import { selectFirstConversation } from "@/store/selectors";
import type { AppState } from "@/store/types";

/**
 * Gives an empty window the first conversation there is.
 *
 * A pane was otherwise only ever opened by a person, so a profile that connects
 * and joins its channels on its own sat on "No conversation open" with those
 * channels listed in the sidebar beside it. The palette already worked around
 * this for a `/join` typed into it; a channel joined by `connect_commands` had
 * no such route. #343.
 *
 * Armed rather than checked once, because a first launch has no conversations
 * at the moment it starts: onboarding saves a network, the connection begins,
 * and the autojoin lands seconds after the startup restore has already found
 * nothing to restore.
 *
 * Only ever into an empty window. A pane is somebody's — including the one this
 * opens, which is what stops it.
 */
export function openFirstConversation(): () => void {
  let stop = () => {};

  const openIfEmpty = (state: AppState & AppActions) => {
    if (state.layout) {
      stop();
      return;
    }
    const first = selectFirstConversation(state);
    // Nothing to open yet. A network that is still connecting has a console and
    // no conversations, and a window is honest to say so until one arrives.
    if (!first) return;
    state.showTarget(first);
  };

  // Subscribed before the first look, so opening a pane below arrives back here
  // as a state with a layout in it and takes the subscription away again.
  stop = useAppStore.subscribe(openIfEmpty);
  openIfEmpty(useAppStore.getState());

  return stop;
}
