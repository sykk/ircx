/**
 * Deterministic nick colour, shared by every surface that names a person.
 *
 * This is the canonical implementation. Colour links a roster entry to a
 * message block and does nothing else, so a second hash anywhere in the app
 * silently breaks that link: import from here rather than reimplementing.
 */

/** Count of `--nick-N` custom properties declared in tokens.css. */
const PALETTE_SIZE = 10;

/** IRC nicks are case-insensitive, so `Sable` and `sable` must agree. */
function hash(nick: string): number {
  let h = 0;
  for (const char of nick.toLowerCase()) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}

/** 1-based index into the `--nick-N` palette. */
export function nickColorIndex(nick: string): number {
  return (hash(nick) % PALETTE_SIZE) + 1;
}

/** A `var(--nick-N)` reference for use in a `style` attribute. */
export function nickColor(nick: string): string {
  return `var(--nick-${nickColorIndex(nick)})`;
}

export { PALETTE_SIZE };
