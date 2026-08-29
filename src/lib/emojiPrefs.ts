const RECENTS_KEY = "ircx.emoji.recents";
const FAVORITES_KEY = "ircx.emoji.favorites";
const USAGE_KEY = "ircx.emoji.usage";
const MAX_RECENTS = 40;

interface EmojiUsage {
  count: number;
  lastUsed: number;
}

function readList(key: string): string[] {
  try {
    const held = localStorage.getItem(key);
    if (!held) return [];
    const parsed: unknown = JSON.parse(held);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* A window that cannot remember still picks emoji for this session. */
  }
}

function readUsage(): Record<string, EmojiUsage> {
  try {
    const held = localStorage.getItem(USAGE_KEY);
    if (!held) return {};
    const parsed: unknown = JSON.parse(held);
    if (typeof parsed !== "object" || parsed === null) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, EmojiUsage] =>
          typeof entry[1] === "object" &&
          entry[1] !== null &&
          typeof (entry[1] as EmojiUsage).count === "number" &&
          typeof (entry[1] as EmojiUsage).lastUsed === "number",
      ),
    );
  } catch {
    return {};
  }
}

export function loadRecents(): string[] {
  return readList(RECENTS_KEY);
}

export function loadFavorites(): string[] {
  return readList(FAVORITES_KEY);
}

/** Most recent first, without duplicates. */
export function recordRecent(native: string): string[] {
  const next = [native, ...loadRecents().filter((held) => held !== native)].slice(0, MAX_RECENTS);
  writeList(RECENTS_KEY, next);
  const usage = readUsage();
  const held = usage[native];
  const lastUsed = Math.max(Date.now(), ...Object.values(usage).map((item) => item.lastUsed + 1));
  usage[native] = { count: (held?.count ?? 0) + 1, lastUsed };
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    /* A window that cannot remember still picks emoji for this session. */
  }
  return next;
}

export function loadMostUsed(limit = 3): string[] {
  const usage = readUsage();
  const ranked = Object.entries(usage)
    .sort((a, b) => b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed)
    .map(([native]) => native);
  return [...ranked, ...loadRecents().filter((native) => !usage[native])].slice(0, limit);
}

export function toggleFavorite(native: string): string[] {
  const held = loadFavorites();
  const next = held.includes(native)
    ? held.filter((item) => item !== native)
    : [...held, native];
  writeList(FAVORITES_KEY, next);
  return next;
}
