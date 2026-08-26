import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { insideTauri, ipc } from "@/lib/ipc";
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
 * There is no sound switch because the plugin takes only the name of a sound;
 * turning it off would still leave whatever the desktop plays for a
 * notification. Such a switch could not promise silence.
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
  /** Local wall-clock range during which desktop notifications stay quiet. */
  quietHours: QuietHours | null;
  /** Per-conversation overrides, keyed the same way as the store. */
  conversations: Record<string, ConversationAttention>;
  /** A watched nick coming online. */
  watchPresence: boolean;
}

export interface QuietHours {
  start: string;
  end: string;
}

export type ConversationAttention = "inherit" | "all" | "highlights" | "mute";

export const DEFAULT_NOTIFICATIONS: Notifications = {
  highlights: false,
  directMessages: false,
  quietHours: null,
  conversations: {},
  watchPresence: false,
};

const ATTENTION_MODES = new Set<ConversationAttention>([
  "inherit",
  "all",
  "highlights",
  "mute",
]);

function clockTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour < 24 && minute < 60;
}

/** localStorage is a text file the reader can edit, so this is untrusted input
 * rather than what was written. Each field falls back on its own. */
export function sanitiseNotifications(raw: unknown): Notifications {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_NOTIFICATIONS;
  }
  const held = raw as Record<string, unknown>;
  const rawQuiet = held.quietHours;
  const quietHours =
    typeof rawQuiet === "object" &&
    rawQuiet !== null &&
    !Array.isArray(rawQuiet) &&
    clockTime((rawQuiet as Record<string, unknown>).start) &&
    clockTime((rawQuiet as Record<string, unknown>).end)
      ? {
          start: (rawQuiet as Record<string, unknown>).start as string,
          end: (rawQuiet as Record<string, unknown>).end as string,
        }
      : null;
  const conversations: Record<string, ConversationAttention> = {};
  if (
    typeof held.conversations === "object" &&
    held.conversations !== null &&
    !Array.isArray(held.conversations)
  ) {
    for (const [key, mode] of Object.entries(held.conversations)) {
      if (typeof mode === "string" && ATTENTION_MODES.has(mode as ConversationAttention)) {
        conversations[key] = mode as ConversationAttention;
      }
    }
  }
  return {
    highlights:
      typeof held.highlights === "boolean"
        ? held.highlights
        : DEFAULT_NOTIFICATIONS.highlights,
    directMessages:
      typeof held.directMessages === "boolean"
        ? held.directMessages
        : DEFAULT_NOTIFICATIONS.directMessages,
    quietHours,
    conversations,
    watchPresence:
      typeof held.watchPresence === "boolean"
        ? held.watchPresence
        : DEFAULT_NOTIFICATIONS.watchPresence,
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

/** Start is inclusive and end is exclusive. Equal endpoints disable the range. */
export function isQuietAt(quiet: QuietHours | null, now: Date): boolean {
  if (quiet === null || quiet.start === quiet.end) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  const startHour = Number(quiet.start.slice(0, 2));
  const startMinute = Number(quiet.start.slice(3, 5));
  const endHour = Number(quiet.end.slice(0, 2));
  const endMinute = Number(quiet.end.slice(3, 5));
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function attentionFor(
  settings: Notifications,
  network: string,
  target: string,
): ConversationAttention {
  return settings.conversations[targetKey(network, target)] ?? "inherit";
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
    hushed: state.hushedNicks,
  };
}

/** Whether this sender is one the reader hushed. Folded the way
 * `isHighlight` folds it, both reading the one list the backend holds. */
function hushed(nick: string): boolean {
  const folded = nick.toLowerCase();
  return useAppStore.getState().hushedNicks.some((held) => held.toLowerCase() === folded);
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
  now = new Date(),
): { title: string; body: string } | null {
  if (message.sender.isSelf) return null;
  // Beside `isSelf` because it is the same kind of question — who spoke, not
  // what they said — and above the per-conversation setting on purpose: a name
  // on this list never interrupts, and a conversation set to every live message
  // is a statement about the conversation rather than about them. This is the
  // half that stops a service notice from raising a direct message, which the
  // highlight rule alone never reached.
  if (hushed(message.sender.nick)) return null;
  if (event.target === SERVER_TARGET || event.target === "") return null;
  // A backfill is not an interruption: it already happened, and the reader
  // asked to see it. The same rule a notification plugin gets.
  if (message.source !== "live") return null;
  if (isQuietAt(settings.quietHours, now)) return null;
  if (muted(event.network, event.target)) return null;
  if (watching(event.network, event.target, focused)) return null;

  const attention = attentionFor(settings, event.network, event.target);
  if (attention === "mute") return null;
  if (attention === "all") {
    return isQuery(event.network, event.target)
      ? { title: message.sender.nick, body: message.text }
      : { title: `${message.sender.nick} in ${event.target}`, body: message.text };
  }

  const highlighted = isHighlight(message, ruleFor(event.network));
  if (attention === "highlights") {
    return highlighted
      ? { title: `${message.sender.nick} in ${event.target}`, body: message.text }
      : null;
  }

  if (isQuery(event.network, event.target)) {
    if (!settings.directMessages) return null;
    return { title: message.sender.nick, body: message.text };
  }

  if (!settings.highlights) return null;
  if (!highlighted) return null;
  return { title: `${message.sender.nick} in ${event.target}`, body: message.text };
}

const WATCH_ONLINE_PREFIX = "ircx-watch-online:";

export function watchNotification(
  event: Extract<IrcxEvent, { type: "notice" }>,
  settings: Notifications,
  now: Date,
): { title: string; body: string } | null {
  if (!settings.watchPresence || isQuietAt(settings.quietHours, now)) return null;
  if (!event.detail?.startsWith(WATCH_ONLINE_PREFIX) || event.network === null) return null;
  const nick = event.detail.slice(WATCH_ONLINE_PREFIX.length);
  if (nick === "") return null;
  const network = useAppStore.getState().networks[event.network]?.name ?? event.network;
  return { title: `${nick} is online`, body: network };
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

  for (const event of events) {
    const presence = event.type === "notice" ? watchNotification(event, settings, new Date()) : null;
    if (presence !== null) {
      try {
        sendNotification(presence);
      } catch (reason) {
        console.warn("ircx could not raise a notification", reason);
      }
      continue;
    }
    if (event.type === "messagesAppended") {
      for (const message of event.messages) {
        const worth = worthNotifying(event, message, settings, windowFocused);
        if (!worth) continue;
        void ipc
          .showMessageNotification(
            worth.title,
            worth.body,
            event.network,
            event.target,
            message.id,
          )
          .catch((reason: unknown) => {
            console.warn("ircx could not raise a notification", reason);
          });
      }
    }
  }
}
