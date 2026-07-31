import { sanitiseOverrides, storeOverrides, storedOverrides } from "./overrides";
import { tokenProblem } from "./parse";

const STORAGE_KEY = "ircx.theme.overrides";

/**
 * Everything reaching here is untrusted input rather than what the editor
 * wrote: localStorage is a text file the user, or anything that ran in the
 * window, can put whatever it likes into.
 */
describe("sanitiseOverrides", () => {
  it("keeps an edit to a token the theme system defines", () => {
    expect(sanitiseOverrides({ "ircx-dark": { "--accent": "#ff00ff" } })).toEqual({
      "ircx-dark": { "--accent": "#ff00ff" },
    });
  });

  /** `setProperty` takes ordinary CSS properties as happily as custom ones, so
   * a name that is not a token would put a stylesheet's worth of styling on
   * `<html>` — here a background the window fetches. */
  it("drops a name that is not one of the theme's tokens", () => {
    const kept = sanitiseOverrides({
      "ircx-dark": { background: "url(https://tracker/x)", "--accent": "#ff00ff" },
    });

    expect(kept).toEqual({ "ircx-dark": { "--accent": "#ff00ff" } });
  });

  /** Tailwind's `@theme` block emits these two onto `:root`, an inline value on
   * the root element would beat them, and they are missing from REQUIRED_TOKENS
   * only because that list comes from theme.css. Whether the font can be
   * changed is a decision nobody has taken; it must not arrive through this
   * door by accident. */
  it("leaves typography out of a theme's reach", () => {
    const kept = sanitiseOverrides({
      "ircx-dark": { "--font-ui": "Comic Sans MS", "--font-mono": "Comic Sans MS" },
    });

    expect(kept).toEqual({ "ircx-dark": {} });
  });

  it.each(["url(https://tracker/x)", "image-set('https://tracker/x' 1x)", "element(#elsewhere)"])(
    "drops %s, which would fetch a remote file the moment a mention is drawn",
    (value) => {
      expect(sanitiseOverrides({ "ircx-dark": { "--mention-bg": value } })).toEqual({
        "ircx-dark": {},
      });
    },
  );

  /** The editor refuses the same value while it is being typed, and the person
   * reading that sentence is looking at a form with several fields in it. */
  it("refuses that value in a sentence naming the token", () => {
    const problem = tokenProblem("--mention-bg", "url(https://tracker/x)");

    expect(problem).toContain("--mention-bg");
    expect(problem).toContain("url()");
  });

  /**
   * The failure the blank-value guard exists to stop, reached by an ordinary
   * paste rather than by an empty field. None of these is a
   * `<declaration-value>`, so `setProperty` does nothing at all with them — it
   * neither throws nor reports — and the token is left unset, which on
   * ircx-light uncovers the dark theme global.css imports statically and paints
   * a dark surface. Copying `#0969da;` out of a stylesheet is exactly how
   * someone gets here.
   */
  it.each(["#0969da;", "#0969da !important", "rgb(0 0 0))"])(
    "drops %s, which a browser would refuse without saying so",
    (value) => {
      expect(sanitiseOverrides({ "ircx-light": { "--surface-base": value } })).toEqual({
        "ircx-light": {},
      });
    },
  );

  /** The other half of that grammar is deliberately let through. Every
   * keystroke in the editor commits, `--scrim` is `rgb(31 35 40 / 0.42)`, and
   * there is no way to type that which does not pass through a bracket that is
   * still open. */
  it("lets a bracket that has not been closed yet through", () => {
    expect(tokenProblem("--scrim", "rgb(31 35 40 / 0.42")).toBeNull();
  });

  it.each([
    ["a string", "ircx-dark"],
    ["a number", 7],
    ["an array", [{ "--accent": "#ff00ff" }]],
    ["null", null],
    ["undefined", undefined],
  ])("comes back empty from %s", (_what, raw) => {
    expect(sanitiseOverrides(raw)).toEqual({});
  });

  it("drops a theme whose edits are not a set of tokens", () => {
    expect(sanitiseOverrides({ "ircx-dark": "#ff00ff" })).toEqual({});
  });

  it("keeps the record a plain map when a theme is named __proto__", () => {
    const kept = sanitiseOverrides({ __proto__: { "--accent": "#ff00ff" } });

    expect(kept).toEqual({});
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  it("drops a value that is not a string", () => {
    const kept = sanitiseOverrides({
      "ircx-dark": { "--accent": 16711935, "--surface-base": null },
    });

    expect(kept).toEqual({ "ircx-dark": {} });
  });
});

describe("the stored overrides", () => {
  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  it("are what the last session left", () => {
    storeOverrides({ "ircx-light": { "--accent": "#0969da" } });

    expect(storedOverrides()).toEqual({ "ircx-light": { "--accent": "#0969da" } });
  });

  /** These are read before the first paint, so nothing here may throw: losing
   * a few edits is better than a window that does not open. */
  it("come back empty from a blob that will not parse", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    expect(storedOverrides()).toEqual({});
  });

  it("are empty before anything was edited", () => {
    expect(storedOverrides()).toEqual({});
  });

  it("go through both gates on the way back in", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "ircx-dark": { background: "url(https://tracker/x)" } }),
    );

    expect(storedOverrides()).toEqual({ "ircx-dark": {} });
  });
});
