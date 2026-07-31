/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.density";

export type DensityId = "compact" | "comfortable" | "read";

export interface Density {
  id: DensityId;
  name: string;
  detail: string;
  /** Null for the density the theme already states, so a theme with its own
   * idea of comfortable keeps it. The other two are the app's, because the
   * point of this setting is to change density without changing palette. */
  tokens: Record<string, string> | null;
}

/**
 * `readability/READABILITY.md` study 05. A density is three numbers and
 * nothing else — the vertical rhythm — which is what lets it be a setting
 * rather than a second theme.
 */
export const DENSITIES: readonly Density[] = [
  {
    id: "compact",
    name: "Compact",
    detail: "For operators and log reading",
    tokens: {
      "--timeline-row-pad-y": "0px",
      "--timeline-block-gap": "6px",
      "--timeline-body-leading": "1.55",
    },
  },
  {
    id: "comfortable",
    name: "Comfortable",
    detail: "For being in the conversation",
    tokens: null,
  },
  {
    id: "read",
    name: "Read",
    detail: "For nine hours of backlog",
    tokens: {
      "--timeline-row-pad-y": "3px",
      "--timeline-block-gap": "20px",
      "--timeline-body-leading": "1.85",
    },
  },
];

export const DEFAULT_DENSITY: DensityId = "comfortable";

export function densityTokens(id: DensityId): Record<string, string> {
  return DENSITIES.find((density) => density.id === id)?.tokens ?? {};
}

export function storedDensity(): DensityId | null {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    return DENSITIES.some((density) => density.id === held) ? (held as DensityId) : null;
  } catch {
    return null;
  }
}

export function storeDensity(id: DensityId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* A window that cannot remember the density still renders at one. */
  }
}
