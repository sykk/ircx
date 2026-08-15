import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  bindingMap,
  chordFor,
  displayChord,
  isTextEntry,
  normalizeChord,
} from "./keybindings";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("normalizeChord", () => {
  it("orders modifiers and cases the key", () => {
    expect(normalizeChord("shift+alt+arrowup")).toBe("Alt+Shift+ArrowUp");
    expect(normalizeChord("mod+k")).toBe("Mod+K");
  });

  it("leaves an already canonical chord alone", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(normalizeChord(binding.chord)).toBe(binding.chord);
    }
  });
});

describe("chordFor", () => {
  it("reads Ctrl as Mod off macOS", () => {
    expect(chordFor(keydown({ key: "k", code: "KeyK", ctrlKey: true }), false)).toBe("Mod+K");
  });

  it("reads Cmd as Mod on macOS", () => {
    expect(chordFor(keydown({ key: "k", code: "KeyK", metaKey: true }), true)).toBe("Mod+K");
  });

  it("keeps Ctrl literal on macOS", () => {
    expect(chordFor(keydown({ key: "n", code: "KeyN", ctrlKey: true }), true)).toBe("Ctrl+N");
  });

  it("does not let Cmd+Ctrl match a Mod chord on macOS", () => {
    const event = keydown({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
    expect(chordFor(event, true)).toBe("Mod+Ctrl+K");
  });

  it("does not let Ctrl+Win match a Mod chord off macOS", () => {
    const event = keydown({ key: "k", code: "KeyK", ctrlKey: true, metaKey: true });
    expect(chordFor(event, false)).toBe("Mod+Meta+K");
  });

  it("uses the physical key, which Alt rewrites on macOS", () => {
    // Alt+1 arrives as `¡` on a Mac keyboard layout.
    const event = keydown({ key: "¡", code: "Digit1", altKey: true, metaKey: true });
    expect(chordFor(event, true)).toBe("Mod+Alt+1");
  });

  it("names the backslash key, which Shift rewrites to a pipe", () => {
    const shifted = keydown({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true });
    expect(chordFor(shifted, false)).toBe("Mod+Shift+\\");
    expect(chordFor(keydown({ key: "\\", code: "Backslash", ctrlKey: true }), false)).toBe(
      "Mod+\\",
    );
  });

  it("names arrows and Escape as themselves", () => {
    expect(chordFor(keydown({ key: "ArrowUp", altKey: true, shiftKey: true }), false)).toBe(
      "Alt+Shift+ArrowUp",
    );
    expect(chordFor(keydown({ key: "Escape" }), false)).toBe("Escape");
  });
});

describe("the shipped table", () => {
  const map = bindingMap(DEFAULT_BINDINGS);

  it.each([
    ["Mod+K", "palette.toggle"],
    ["Mod+\\", "pane.splitVertical"],
    ["Mod+Shift+\\", "pane.splitHorizontal"],
    ["Mod+W", "pane.close"],
    ["Alt+ArrowUp", "pane.previous"],
    ["Alt+ArrowDown", "pane.next"],
    ["Alt+Shift+ArrowUp", "target.previousUnread"],
    ["Alt+Shift+ArrowDown", "target.nextUnread"],
    ["Alt+ArrowLeft", "history.back"],
    ["Alt+ArrowRight", "history.forward"],
    ["Mod+Shift+M", "roster.toggle"],
    ["Mod+Shift+N", "timeline.nickEveryLine"],
    ["Mod+Shift+U", "timeline.unread"],
    ["Mod+Shift+H", "timeline.nextMention"],
    ["Mod+Shift+L", "timeline.latest"],
    ["Mod+F", "search.open"],
    ["Escape", "overlay.dismiss"],
  ])("binds %s to %s", (chord, action) => {
    expect(map.get(chord)?.action).toBe(action);
  });

  it("binds Mod+1 through Mod+9 to a numbered jump", () => {
    for (let n = 1; n <= 9; n++) {
      const binding = map.get(`Mod+${n}`);
      expect(binding?.action).toBe("target.jump");
      expect(binding?.arg).toBe(n);
    }
  });

  it("lets exactly the overlay, pane, target-walking and reading chords through while typing", () => {
    const typing = DEFAULT_BINDINGS.filter((b) => b.whenTyping).map((b) => b.chord);
    expect(typing.toSorted()).toEqual(
      [
        "Alt+ArrowDown",
        "Alt+ArrowUp",
        "Alt+Shift+ArrowDown",
        "Alt+Shift+ArrowUp",
        "Escape",
        "Mod+,",
        "Mod+F",
        "Mod+K",
        "Mod+Shift+H",
        "Mod+Shift+L",
        "Mod+W",
        "Mod+Shift+N",
        "Mod+Shift+U",
        "Mod+Shift+\\",
        "Mod+\\",
      ].toSorted(),
    );
  });

  it("has no duplicate chords", () => {
    expect(map.size).toBe(DEFAULT_BINDINGS.length);
  });
});

describe("isTextEntry", () => {
  function element(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild as HTMLElement;
  }

  it("recognises text inputs, textareas, and contenteditable", () => {
    expect(isTextEntry(element("<input>"))).toBe(true);
    expect(isTextEntry(element('<input type="search">'))).toBe(true);
    expect(isTextEntry(element("<textarea></textarea>"))).toBe(true);
    expect(isTextEntry(element('<div contenteditable="true"></div>'))).toBe(true);
  });

  it("does not treat buttons, checkboxes, or plain elements as text entry", () => {
    expect(isTextEntry(element('<input type="checkbox">'))).toBe(false);
    expect(isTextEntry(element("<button></button>"))).toBe(false);
    expect(isTextEntry(element("<div></div>"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("displayChord", () => {
  it("writes the platform's modifier names", () => {
    expect(displayChord("Mod+K", false)).toBe("Ctrl+K");
    expect(displayChord("Mod+K", true)).toBe("⌘K");
    expect(displayChord("Alt+Shift+ArrowUp", false)).toBe("Alt+Shift+↑");
  });
});
