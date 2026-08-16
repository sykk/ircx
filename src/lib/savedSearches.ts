const STORAGE_KEY = "ircx.search.saved";
const LIMIT = 12;

export function loadSavedSearches(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((query): query is string => typeof query === "string" && query.trim() !== "")
      .map((query) => query.trim())
      .filter((query, index, all) => all.indexOf(query) === index)
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function saveSearch(query: string): string[] {
  const normalized = query.trim();
  if (normalized === "") return loadSavedSearches();
  return write([normalized, ...loadSavedSearches().filter((held) => held !== normalized)]);
}

export function removeSavedSearch(query: string): string[] {
  return write(loadSavedSearches().filter((held) => held !== query));
}

function write(searches: string[]): string[] {
  const next = searches.slice(0, LIMIT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The searches remain available until this window closes.
  }
  return next;
}
