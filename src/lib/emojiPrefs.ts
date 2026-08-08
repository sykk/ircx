const RECENTS_KEY = "ircx.emoji.recents";
const FAVORITES_KEY = "ircx.emoji.favorites";
const MAX_RECENTS = 40;

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

export function loadRecents(): string[] {
  return readList(RECENTS_KEY);
}

export function loadFavorites(): string[] {
  return readList(FAVORITES_KEY);
}

export function isFavorite(native: string): boolean {
  return loadFavorites().includes(native);
}

/** Most recent first, without duplicates. */
export function recordRecent(native: string): string[] {
  const next = [native, ...loadRecents().filter((held) => held !== native)].slice(0, MAX_RECENTS);
  writeList(RECENTS_KEY, next);
  return next;
}

export function toggleFavorite(native: string): string[] {
  const held = loadFavorites();
  const next = held.includes(native)
    ? held.filter((item) => item !== native)
    : [...held, native];
  writeList(FAVORITES_KEY, next);
  return next;
}
