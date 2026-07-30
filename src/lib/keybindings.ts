/* The chord table and the event-to-chord normalisation the dispatcher uses.
 *
 * Bindings are data so that M4 themes and plugins can add or replace entries
 * without touching `useHotkeys`. A chord is written modifiers-first in the
 * order Mod, Ctrl, Alt, Shift, then the key: `Mod+Shift+M`, `Alt+ArrowUp`.
 * `Mod` is Cmd on macOS and Ctrl everywhere else; write `Ctrl` only when you
 * mean the physical Control key on a Mac too.
 */

export type ActionId =
  | "palette.toggle"
  | "search.open"
  | "drawer.toggle"
  | "pane.splitVertical"
  | "pane.splitHorizontal"
  | "pane.close"
  | "pane.previous"
  | "pane.next"
  | "target.previousUnread"
  | "target.nextUnread"
  | "target.jump"
  | "history.back"
  | "history.forward"
  | "overlay.dismiss";

export interface Binding {
  chord: string;
  action: ActionId;
  /** Passed to the handler. `target.jump` uses it as a 1-based position. */
  arg?: number;
  /** Fire even when focus is in a composer, search box, or other text entry.
   * Off by default: Ctrl+1 must not switch channels mid-sentence. */
  whenTyping?: boolean;
  description: string;
}

export const DEFAULT_BINDINGS: readonly Binding[] = [
  { chord: "Mod+K", action: "palette.toggle", whenTyping: true, description: "Command palette" },
  { chord: "Mod+F", action: "search.open", whenTyping: true, description: "Search current target" },
  { chord: "Mod+Shift+M", action: "drawer.toggle", description: "Toggle context panel" },

  { chord: "Mod+\\", action: "pane.splitVertical", whenTyping: true, description: "Split pane side by side" },
  { chord: "Mod+Shift+\\", action: "pane.splitHorizontal", whenTyping: true, description: "Split pane top and bottom" },
  { chord: "Mod+W", action: "pane.close", whenTyping: true, description: "Close pane" },

  // These two walked the target list before there were panes, and still do
  // while there is one pane. Once the window is split, moving between the panes
  // is the more immediate need; target walking keeps the numbered jumps, the
  // unread chords and the palette.
  { chord: "Alt+ArrowUp", action: "pane.previous", whenTyping: true, description: "Previous pane, or previous target when unsplit" },
  { chord: "Alt+ArrowDown", action: "pane.next", whenTyping: true, description: "Next pane, or next target when unsplit" },
  { chord: "Alt+Shift+ArrowUp", action: "target.previousUnread", whenTyping: true, description: "Previous unread" },
  { chord: "Alt+Shift+ArrowDown", action: "target.nextUnread", whenTyping: true, description: "Next unread" },
  // Not while typing: Alt+Left and Alt+Right move the caret by word in every
  // text field, and a client that eats that mid-message is worse than one
  // without history keys.
  { chord: "Alt+ArrowLeft", action: "history.back", description: "Back" },
  { chord: "Alt+ArrowRight", action: "history.forward", description: "Forward" },

  ...Array.from({ length: 9 }, (_, i): Binding => ({
    chord: `Mod+${i + 1}`,
    action: "target.jump",
    arg: i + 1,
    description: `Jump to target ${i + 1}`,
  })),

  { chord: "Escape", action: "overlay.dismiss", whenTyping: true, description: "Close overlay" },
];

const MODIFIERS = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;

export const isMac =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Canonical form of a written chord, so a plugin may write `shift+alt+arrowup`. */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").filter(Boolean);
  const key = parts[parts.length - 1] ?? "";
  const held = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const order = MODIFIERS.filter((m) => held.has(m.toLowerCase()));
  return [...order, canonicalKey(key)].join("+");
}

export function chordFor(event: KeyboardEvent, mac = isMac): string {
  const parts: string[] = [];
  // Cmd and Ctrl are distinct keys on a Mac, so only one of them is `Mod`
  // there and the other stays literal. Listing both keeps `Mod+K` from
  // firing on Ctrl+Cmd+K.
  if (mac) {
    if (event.metaKey) parts.push("Mod");
    if (event.ctrlKey) parts.push("Ctrl");
  } else {
    if (event.ctrlKey) parts.push("Mod");
    if (event.metaKey) parts.push("Meta");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(eventKey(event));
  return parts.join("+");
}

/** `event.key` carries the composed character, which Alt mangles on macOS
 * (Alt+1 arrives as `¡`). The physical key is what a chord names. */
function eventKey(event: KeyboardEvent): string {
  const code = event.code;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_KEYS[code] ?? canonicalKey(event.key);
}

/** Punctuation whose `event.key` Shift rewrites: Shift+Backslash arrives as
 * `|`, and `Mod+Shift+\` names the key, not the character it produced. */
const CODE_KEYS: Record<string, string> = { Backslash: "\\" };

function canonicalKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return NAMED_KEYS[key.toLowerCase()] ?? key;
}

/** So a plugin may write `alt+arrowup` and land on the same entry as
 * `Alt+ArrowUp`. Anything absent here keeps the spelling it was given. */
const NAMED_KEYS: Record<string, string> = Object.fromEntries(
  [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Escape",
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].map((key) => [key.toLowerCase(), key]),
);

export function bindingMap(bindings: readonly Binding[]): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const binding of bindings) map.set(normalizeChord(binding.chord), binding);
  return map;
}

/** Chord as a user reads it, for the palette's shortcut hints. */
export function displayChord(chord: string, mac = isMac): string {
  return normalizeChord(chord)
    .split("+")
    .map((part) => {
      if (part === "Mod") return mac ? "⌘" : "Ctrl";
      if (part === "Alt") return mac ? "⌥" : "Alt";
      if (part === "Shift") return mac ? "⇧" : "Shift";
      if (part === "Meta") return mac ? "⌘" : "Win";
      if (part.startsWith("Arrow")) return ARROWS[part] ?? part;
      if (part === "Escape") return "Esc";
      return part;
    })
    .join(mac ? "" : "+");
}

const ARROWS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Whether a key event landed in something the user is typing into. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // The event target inside a rich composer is the deepest element, which need
  // not carry the attribute itself.
  const editable = target.closest("[contenteditable]");
  if (editable && editable.getAttribute("contenteditable") !== "false") return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !NON_TEXT_INPUTS.has(type);
}

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
