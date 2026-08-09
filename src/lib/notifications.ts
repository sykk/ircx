import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { insideTauri } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { isHighlight, type HighlightRule } from "@/store/selectors";
import { SERVER_TARGET, type ChatMessage, type IrcxEvent } from "@/types";

/** Beside the appearance settings, and for their reason: what may interrupt the
 * reader is a preference the backend has no use for. The words and the mutes
 * are the backend's because the badge is counted there; nothing in Rust needs
 * to know whether a desktop notification was wanted. */
const STORAGE_KEY = "ircx.notifications";

/**
 * What is worth raising a desktop notification for.
 *
 * Two switches rather than the three `docs/notifications.md` proposed. The
 * sound went, because it could not be told the truth: the plugin takes the
 * *name* of a sound to play, so turning it off leaves whatever the desktop
 * plays for a notification anyway. A switch labelled Sound that cannot make one
 * silent is worse than no switch.
 *
 * Both default to off. A client that starts interrupting somebody the first
 * time it is run has decided something that was theirs to decide.
 */
export interface Notifications {
  /** Your nickname, or one of your words, in a channel. */
  highlights: boolean;
  /** Any line in a query, which carries no keyword and needs none: somebody
   * opened a conversation with you and nobody else. */
  directMessages: boolean;
}

export const DEFAULT_NOTIFICATIONS: Notifications = {
  highlights: false,
  directMessages: false,
};

/** localStorage is a text file the reader can edit, so this is untrusted input
 * rather than what was written. Each field falls back on its own. */
export function sanitiseNotifications(raw: unknown): Notifications {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_NOTIFICATIONS;
  }
  const held = raw as Record<string, unknown>;
  return {
    highlights:
      typeof held.highlights === "boolean"
        ? held.highlights
        : DEFAULT_NOTIFICATIONS.highlights,
    directMessages:
      typeof held.directMessages === "boolean"
        ? held.directMessages
        : DEFAULT_NOTIFICATIONS.directMessages,
  };
}

export function storedNotifications(): Notifications {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    return held === null ? DEFAULT_NOTIFICATIONS : sanitiseNotifications(JSON.parse(held));
  } catch {
    return DEFAULT_NOTIFICATIONS;
  }
}

/**
 * Writes the switches.
 *
 * Nothing announces the change to the other window, unlike every appearance
 * setting. Those are cached in the client's store and have to be pushed at it;
 * these are read out of localStorage as each batch of messages arrives, and
 * both windows are one origin. A message saying "go and look" would be telling
 * the client to do what it already does per batch.
 */
export function storeNotifications(next: Notifications): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* A window that cannot remember the setting still obeys it while it runs. */
  }
}

/**
 * Asks the desktop for permission, if it has not been asked.
 *
 * Called when a switch is turned on rather than at startup: the prompt is a
 * question about something the reader has just asked for, and a client that
 * asks on first launch is asking before there is anything to notify about.
 */
export async function allowedToNotify(): Promise<boolean> {
  if (!insideTauri()) return false;
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (reason) {
    console.warn("ircx could not ask about notification permission", reason);
    return false;
  }
}

/** Whether the client window has the desktop's focus. Kept here rather than in
 * the store: nothing draws from it, and a re-render per focus change would be
 * a re-render for walking away from the machine. */
let windowFocused = true;

/**
 * Raises a desktop notification for anything in these events worth one.
 *
 * Wired into the event bridge rather than into a store subscription, because
 * the question is about what *arrived* — a state comparison would have to work
 * out which messages are new, and the events already say.
 *
 * Resolves to an unsubscribe function for the focus listener.
 */
export async function startNotifications(): Promise<() => void> {
  if (!insideTauri()) return () => {};
  try {
    windowFocused = await getCurrentWindow().isFocused();
    return await getCurrentWindow().onFocusChanged(({ payload }) => {
      windowFocused = payload;
    });
  } catch (reason) {
    // Assume focused, which is the quieter of the two: a client that cannot
    // tell should not interrupt somebody who is looking straight at it.
    windowFocused = true;
    console.warn("ircx could not follow whether its window has focus", reason);
    return () => {};
  }
}

/**
 * Whether this conversation is the one the reader is looking at.
 *
 * Focus rather than merely being on screen, and the pane's focus rather than
 * the window's alone: a channel in the other half of a split is not one they
 * are reading, which is the rule `followFocus` in `bridge.ts` already applies
 * to marking a conversation read.
 */
function watching(network: string, target: string, focused: boolean): boolean {
  if (!focused) return false;
  const state = useAppStore.getState();
  const view = state.activeViewId ? state.views[state.activeViewId] : undefined;
  if (!view || view.network !== network) return false;
  return view.target.toLowerCase() === target.toLowerCase();
}

/** The rule as the timeline would apply it, for the network this message is
 * on. */
function ruleFor(network: string): HighlightRule {
  const state = useAppStore.getState();
  return {
    nick: state.networks[network]?.currentNick ?? null,
    words: state.highlightWords,
  };
}

/** Whether the conversation, or the network it is on, was muted. Read off the
 * conversation rather than a list, because the backend already put the answer
 * there. */
function muted(network: string, target: string): boolean {
  const state = useAppStore.getState();
  const key = targetKey(network, target);
  return state.channels[key]?.muted ?? state.queries[key]?.muted ?? false;
}

/** A channel message, or a query. The server console is neither, and a message
 * there is the network talking rather than a person. */
function isQuery(network: string, target: string): boolean {
  return useAppStore.getState().queries[targetKey(network, target)] !== undefined;
}

/**
 * What one arriving message is worth, or null for nothing.
 *
 * Exported for the tests, which is also the shape the rule is easiest to read
 * in: every reason to stay quiet in one place, in the order they cost least to
 * ask.
 */
export function worthNotifying(
  event: Extract<IrcxEvent, { type: "messagesAppended" }>,
  message: ChatMessage,
  settings: Notifications,
  focused: boolean,
): { title: string; body: string } | null {
  if (message.sender.isSelf) return null;
  if (event.target === SERVER_TARGET || event.target === "") return null;
  // A backfill is not an interruption: it already happened, and the reader
  // asked to see it. The same rule a notification plugin gets.
  if (message.source !== "live") return null;
  if (muted(event.network, event.target)) return null;
  if (watching(event.network, event.target, focused)) return null;

  if (isQuery(event.network, event.target)) {
    if (!settings.directMessages) return null;
    return { title: message.sender.nick, body: message.text };
  }

  if (!settings.highlights) return null;
  if (!isHighlight(message, ruleFor(event.network))) return null;
  return { title: `${message.sender.nick} in ${event.target}`, body: message.text };
}

/**
 * Raises whatever these events are worth.
 *
 * Called after the store has taken them, so `muted` and `watching` are asked
 * against the state the reader is actually looking at rather than the one
 * before this batch.
 */
export function notifyForEvents(events: readonly IrcxEvent[]): void {
  if (!insideTauri()) return;
  const settings = storedNotifications();
  if (!settings.highlights && !settings.directMessages) return;

  for (const event of events) {
    if (event.type !== "messagesAppended") continue;
    for (const message of event.messages) {
      const worth = worthNotifying(event, message, settings, windowFocused);
      if (!worth) continue;
      try {
        sendNotification(worth);
      } catch (reason) {
        // One notification that could not be raised is not a reason to lose the
        // rest of the batch, or the conversation it belongs to.
        console.warn("ircx could not raise a notification", reason);
      }
    }
  }
}
