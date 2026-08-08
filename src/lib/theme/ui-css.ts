/** What ui.css must not do: reach the network or run script. Same bar as token
 * values in parse.ts — a theme is colours and motion, not a fetch. */
const BLOCKED = [
  { pattern: /@import\b/i, said: "@import" },
  { pattern: /-moz-binding\s*:/i, said: "-moz-binding" },
  { pattern: /\bbehavior\s*:/i, said: "behavior" },
  { pattern: /javascript\s*:/i, said: "javascript:" },
  { pattern: /\bexpression\s*\(/i, said: "expression()" },
  { pattern: /\burl\s*\(/i, said: "url()" },
] as const;

export const UI_STYLE_ID = "ircx-theme-ui";

/** Names one forbidden construct, or null when ui.css is acceptable. */
export function uiStylesheetProblem(css: string): string | null {
  const trimmed = css.trim();
  if (trimmed === "") return null;

  for (const { pattern, said } of BLOCKED) {
    if (pattern.test(trimmed)) {
      return `ui.css uses ${said}. A theme sets appearance on this computer; it does not fetch remote files or run script.`;
    }
  }

  return null;
}

/** Ensures the injected stylesheet node exists and returns it. */
export function uiStyleElement(): HTMLStyleElement {
  let node = document.getElementById(UI_STYLE_ID) as HTMLStyleElement | null;
  if (!node) {
    node = document.createElement("style");
    node.id = UI_STYLE_ID;
    document.head.appendChild(node);
  }
  return node;
}

/** Writes sanitized ui.css, or clears the node when there is none. */
export function applyUiStylesheet(css: string): void {
  const node = uiStyleElement();
  node.textContent = css.trim() === "" ? "" : css;
}

/** Removes the injected node entirely — for tests that reset the document. */
export function clearUiStylesheet(): void {
  document.getElementById(UI_STYLE_ID)?.remove();
}
