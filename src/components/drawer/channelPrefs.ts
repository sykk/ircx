import { useCallback, useState } from "react";
import type { TargetKey } from "@/store/keys";

export type NotifyLevel = "all" | "highlights" | "none";

export const NOTIFY_LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "Every message raises a notification" },
  {
    value: "highlights",
    label: "Highlights only",
    hint: "Only when your nick is mentioned",
  },
  { value: "none", label: "Nothing", hint: "The channel stays silent" },
];

export const RETENTION_CHOICES = [
  { value: "default", label: "Follow the global setting" },
  { value: "7", label: "Keep 7 days" },
  { value: "30", label: "Keep 30 days" },
  { value: "90", label: "Keep 90 days" },
  { value: "365", label: "Keep a year" },
  { value: "forever", label: "Keep everything" },
] as const;

export type RetentionChoice = (typeof RETENTION_CHOICES)[number]["value"];

export interface ChannelPrefs {
  notify: NotifyLevel;
  retention: RetentionChoice;
}

const DEFAULTS: ChannelPrefs = { notify: "all", retention: "default" };

/* Per-channel preferences have no home in the app store or the IPC contract
 * yet — `Store::set_retention` is still unwritten. They live in localStorage so
 * the tabs do something real, and this file is the only place that knows it:
 * point the two functions below at the store when the fields land. */
const STORAGE_PREFIX = "ircx.channelPrefs.";

export function readPrefs(key: TargetKey): ChannelPrefs {
  const raw = localStorage.getItem(STORAGE_PREFIX + key);
  if (!raw) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ChannelPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function writePrefs(key: TargetKey, patch: Partial<ChannelPrefs>): ChannelPrefs {
  const next = { ...readPrefs(key), ...patch };
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(next));
  return next;
}

/** Reads once per mount: callers pass `key` as the React key so switching
 * channel remounts rather than resyncing. */
export function useChannelPrefs(
  key: TargetKey,
): [ChannelPrefs, (patch: Partial<ChannelPrefs>) => void] {
  const [prefs, setPrefs] = useState(() => readPrefs(key));
  const update = useCallback(
    (patch: Partial<ChannelPrefs>) => setPrefs(writePrefs(key, patch)),
    [key],
  );
  return [prefs, update];
}
