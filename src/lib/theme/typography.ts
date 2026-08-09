/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.typography";

export interface Face {
  id: string;
  name: string;
  /** Ends in a generic family, so a face nobody has installed still resolves to
   * something rather than to the browser's last resort. typography.test.ts
   * asserts it for every entry. */
  stack: string;
}

/**
 * The faces prose may be set in.
 *
 * A list rather than a box to type a family into. src/lib/theme/overrides.ts
 * keeps `--font-ui` and `--font-mono` out of a theme's reach on the argument
 * that an arbitrary value on the root element is a stylesheet-shaped hole; a
 * fixed list is the same door opened only as far as the reader needs it, and
 * nothing arbitrary reaches `setProperty`.
 *
 * `mono` is the terminal look — prose set in the same face as the identifiers —
 * which is what the classic preset wants. It resolves to whichever mono face is
 * in force rather than naming one, so the two settings cannot disagree.
 */
export const PROSE_FACES: readonly Face[] = [
  {
    id: "inter",
    name: "Inter",
    stack: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  { id: "system", name: "System UI", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "georgia", name: "Georgia", stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  { id: "mono", name: "Same as mono", stack: "" },
];

export const MONO_FACES: readonly Face[] = [
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace',
  },
  {
    id: "system",
    name: "System mono",
    stack: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace',
  },
  { id: "courier", name: "Courier", stack: '"Courier New", Courier, monospace' },
];

/** What the window may be scaled to. Whole-window rather than a text size: the
 * app sets its type in px, so a root font-size moves nothing, and these go to
 * the webview's own zoom where every measurement scales together. */
export const ZOOM_LEVELS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25];

export interface Typography {
  prose: string;
  mono: string;
  zoom: number;
}

export const DEFAULT_TYPOGRAPHY: Typography = { prose: "inter", mono: "jetbrains", zoom: 1 };

function faceStack(faces: readonly Face[], id: string, fallback: string): string {
  return faces.find((face) => face.id === id)?.stack ?? fallback;
}

/** The two font properties, resolved. `mono` prose takes the mono stack, so
 * changing the mono face changes both at once. */
export function fontTokens(typography: Typography): Record<string, string> {
  const mono = faceStack(MONO_FACES, typography.mono, MONO_FACES[0]!.stack);
  const prose =
    typography.prose === "mono"
      ? mono
      : faceStack(PROSE_FACES, typography.prose, PROSE_FACES[0]!.stack);
  return { "--font-ui": prose, "--font-mono": mono };
}

/** Field by field, from anything at all — localStorage is a text file the user
 * can edit. An unrecognised face falls back on its own rather than taking the
 * other two down with it. */
export function sanitiseTypography(raw: unknown): Typography {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_TYPOGRAPHY;
  const held = raw as Record<string, unknown>;
  return {
    prose: PROSE_FACES.some((face) => face.id === held.prose)
      ? (held.prose as string)
      : DEFAULT_TYPOGRAPHY.prose,
    mono: MONO_FACES.some((face) => face.id === held.mono)
      ? (held.mono as string)
      : DEFAULT_TYPOGRAPHY.mono,
    zoom: ZOOM_LEVELS.includes(held.zoom as number)
      ? (held.zoom as number)
      : DEFAULT_TYPOGRAPHY.zoom,
  };
}

export function storedTypography(): Typography {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    return held === null ? DEFAULT_TYPOGRAPHY : sanitiseTypography(JSON.parse(held));
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

export function storeTypography(next: Typography): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* A window that cannot remember the face still renders in it. */
  }
}
