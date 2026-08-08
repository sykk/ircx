import type { StoredLayout } from "@/store/types";

const STORAGE_KEY = "ircx.shell.view";

export interface ViewState {
  sidebarWidth: number;
  /** Null until somebody drags the member list's edge; it sizes itself to its
   * longest name until then. */
  rosterWidth: number | null;
  collapsedNetworks: string[];
  /** How the panes divided the window, or null before anything was opened. */
  layout: StoredLayout | null;
}

/** Returns null when nothing is stored or the entry cannot be trusted; a
 * corrupt value must not stop the window from rendering. */
export function loadViewState(): ViewState | null {
  const parsed = read();
  if (!parsed) return null;

  const { sidebarWidth, collapsedNetworks } = parsed as Partial<ViewState>;
  if (typeof sidebarWidth !== "number" || !Array.isArray(collapsedNetworks)) return null;

  return {
    sidebarWidth,
    // Read on its own for the same reason the layout is: an entry written
    // before the roster could be dragged carries no width, and that is not a
    // reason to throw away the sidebar stored beside it.
    rosterWidth: typeof parsed.rosterWidth === "number" ? parsed.rosterWidth : null,
    collapsedNetworks: collapsedNetworks.filter((id) => typeof id === "string"),
    // Read on its own so an entry written before there was a layout, or one
    // holding a layout that cannot be trusted, still yields the sidebar.
    layout: storedLayout((parsed as Partial<ViewState>).layout),
  };
}

/**
 * Merges over what is already stored rather than replacing it. The layout is
 * only known once a pane is open, so a write before then says nothing about it
 * — and a write that replaced the whole entry would be saying it is gone.
 */
export function saveViewState(patch: Partial<ViewState>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), ...patch }));
}

function read(): Record<string, unknown> | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as Record<string, unknown>;
}

/** localStorage holds whatever was last written there, including by an older
 * build, so the shape is checked rather than asserted. */
function storedLayout(value: unknown): StoredLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;

  if (node.type === "view") {
    if (typeof node.network !== "string" || typeof node.target !== "string") return null;
    return { type: "view", network: node.network, target: node.target, raw: node.raw === true };
  }

  if (node.type !== "split") return null;
  if (node.direction !== "row" && node.direction !== "column") return null;
  if (!Array.isArray(node.children) || node.children.length !== 2) return null;

  // A side that cannot be read collapses its split, the same as a side whose
  // conversation has gone: what is left is a pane rather than a divider around
  // nothing.
  const first = storedLayout(node.children[0]);
  const second = storedLayout(node.children[1]);
  if (!first) return second;
  if (!second) return first;

  const split: StoredLayout = {
    type: "split",
    direction: node.direction,
    children: [first, second],
  };
  // An absent share is an even half, and so is one no divider could have
  // produced, so both leave the field off rather than storing a nonsense.
  if (typeof node.ratio === "number" && node.ratio > 0 && node.ratio < 1) {
    split.ratio = node.ratio;
  }
  return split;
}
