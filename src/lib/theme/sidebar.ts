const STORAGE_KEY = "ircx.sidebar.compact";

export function storedSidebarCompact(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeSidebarCompact(compact: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(compact));
  } catch {
    // The setting still applies for this session when storage is unavailable.
  }
}
