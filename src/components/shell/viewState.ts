const STORAGE_KEY = "ircx.shell.view";

export interface ViewState {
  sidebarWidth: number;
  collapsedNetworks: string[];
}

/** Returns null when nothing is stored or the entry cannot be trusted; a
 * corrupt value must not stop the window from rendering. */
export function loadViewState(): ViewState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { sidebarWidth, collapsedNetworks } = parsed as Partial<ViewState>;
  if (typeof sidebarWidth !== "number" || !Array.isArray(collapsedNetworks)) return null;

  return {
    sidebarWidth,
    collapsedNetworks: collapsedNetworks.filter((id) => typeof id === "string"),
  };
}

export function saveViewState(state: ViewState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
