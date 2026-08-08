import { applyDensity, applyOverrides, applyTheme } from "./apply";
import { DEFAULT_DENSITY, storeDensity, storedDensity } from "./density";
import { catalogue } from "./load";
import type { Theme } from "./types";
import { UI_STYLE_ID, clearUiStylesheet } from "./ui-css";

function builtIn(id: string): Theme {
  const theme = catalogue().themes.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`no built-in theme ${id}`);
  return theme;
}

describe("applyTheme", () => {
  const root = document.documentElement;

  afterEach(() => {
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
    clearUiStylesheet();
  });

  it("writes the theme's tokens and its appearance", () => {
    applyTheme(builtIn("ircx-light"));

    expect(root.style.getPropertyValue("--surface-base")).toBe("#ffffff");
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("ircx-light");
  });

  it("leaves nothing of the theme it replaced behind", () => {
    applyTheme({
      id: "sparse",
      manifest: { name: "Sparse", author: "a", version: "1.0.0", appearance: "dark" },
      tokens: { "--surface-base": "#010203" },
      uiStylesheet: "",
    });
    applyTheme(builtIn("ircx-light"));
    applyTheme({
      id: "sparser",
      manifest: { name: "Sparser", author: "a", version: "1.0.0", appearance: "dark" },
      tokens: { "--surface-base": "#040506" },
      uiStylesheet: "",
    });

    expect(root.style.getPropertyValue("--text-primary")).toBe("");
    expect(root.style.getPropertyValue("--surface-base")).toBe("#040506");
  });

  // The window still has colours after this: global.css imports the dark
  // theme, and removing the inline properties is what uncovers it.
  it("falls back to the built-in dark theme", () => {
    applyTheme(builtIn("ircx-light"));
    applyTheme(null);

    expect(root.style.getPropertyValue("--surface-base")).toBe("");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.theme).toBe("ircx-dark");
  });

  it("injects ui.css from the theme", () => {
    applyTheme({
      id: "animated",
      manifest: { name: "Animated", author: "a", version: "1.0.0", appearance: "dark" },
      tokens: { "--surface-base": "#010203" },
      uiStylesheet: "[data-ui='timeline'] { opacity: 0.95; }",
    });

    expect(document.getElementById(UI_STYLE_ID)?.textContent).toContain("[data-ui='timeline']");
  });
});

/**
 * #85. A density is three of the theme's own tokens, written to the same inline
 * declaration on the root, so the two cannot be painted independently: clearing
 * either one would take the other's value with it.
 */
describe("applyDensity", () => {
  const root = document.documentElement;

  /** States a density token as well as a colour, which is what makes the two
   * collide. */
  const dense: Theme = {
    id: "dense",
    manifest: { name: "Dense", author: "a", version: "1.0.0", appearance: "dark" },
    tokens: { "--surface-base": "#010203", "--timeline-block-gap": "11px" },
    uiStylesheet: "",
  };

  afterEach(() => {
    applyTheme(null);
    applyDensity(DEFAULT_DENSITY);
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
  });

  it("overrides the theme's rhythm and leaves the rest of it alone", () => {
    applyTheme(dense);
    applyDensity("compact");

    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("6px");
    expect(root.style.getPropertyValue("--surface-base")).toBe("#010203");
  });

  /** The one the theme states. Going back to it has to uncover the theme's
   * value rather than clear the property outright, which would drop through to
   * whatever global.css happens to say. */
  it("gives the theme its rhythm back", () => {
    applyTheme(dense);
    applyDensity("compact");
    applyDensity("comfortable");

    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("11px");
  });

  it("survives a theme change", () => {
    applyDensity("read");
    applyTheme(dense);

    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("20px");
    expect(root.style.getPropertyValue("--surface-base")).toBe("#010203");
  });

  it("outlives the theme it was set under", () => {
    applyDensity("compact");
    applyTheme(dense);
    applyTheme(null);

    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("6px");
    expect(root.style.getPropertyValue("--surface-base")).toBe("");
  });
});

/**
 * An override is one person's edit to one theme, and it paints between the two
 * things that also claim those tokens: above the theme, whose values it is an
 * edit to, and below the density, which is the app's rhythm rather than anyone's
 * palette.
 */
describe("applyOverrides", () => {
  const root = document.documentElement;

  /** States a density token beside a colour, which is what puts all three
   * layers in contention over one property. */
  const dense: Theme = {
    id: "dense",
    manifest: { name: "Dense", author: "a", version: "1.0.0", appearance: "dark" },
    tokens: { "--surface-base": "#010203", "--timeline-block-gap": "11px" },
    uiStylesheet: "",
  };

  afterEach(() => {
    applyTheme(null);
    applyDensity(DEFAULT_DENSITY);
    applyOverrides({});
    root.removeAttribute("style");
    root.removeAttribute("data-theme");
  });

  it("beats the theme it is an edit to", () => {
    applyTheme(dense);
    applyOverrides({ dense: { "--surface-base": "#0a0b0c" } });

    expect(root.style.getPropertyValue("--surface-base")).toBe("#0a0b0c");
  });

  /** Comfortable states no tokens of its own, so under it the three density
   * properties are the theme's and an edit to one of them is an edit that
   * shows. Compact states all three, and its rhythm is the setting's whole
   * point, so there the same edit is buried. Both halves are the one merge
   * order read from either end, and going back to comfortable has to uncover
   * the edit rather than the theme's value underneath it. */
  it("shows under comfortable and gives way to compact", () => {
    applyTheme(dense);
    applyOverrides({ dense: { "--timeline-block-gap": "14px" } });
    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("14px");

    applyDensity("compact");
    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("6px");

    applyDensity("comfortable");
    expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("14px");
  });

  /** ircx-light on purpose. Removing the property rather than repainting the
   * theme's value would drop through to the dark theme global.css imports
   * statically, and on a dark theme that failure paints the same colour as
   * success. */
  it("gives the theme its own colour back when the edit goes", () => {
    applyTheme(builtIn("ircx-light"));
    applyOverrides({ "ircx-light": { "--surface-base": "#123456" } });
    applyOverrides({});

    expect(root.style.getPropertyValue("--surface-base")).toBe("#ffffff");
  });

  it("paints the edits belonging to the theme in force", () => {
    applyOverrides({
      "ircx-light": { "--surface-base": "#eeeeee" },
      "ircx-dark": { "--surface-base": "#111111" },
    });

    applyTheme(builtIn("ircx-light"));
    expect(root.style.getPropertyValue("--surface-base")).toBe("#eeeeee");

    applyTheme(builtIn("ircx-dark"));
    expect(root.style.getPropertyValue("--surface-base")).toBe("#111111");
  });

  /** A window whose theme failed to load opens on the plain dark theme, not on
   * the dark theme wearing an accent chosen for some other palette. */
  it("merges nothing when no theme is applied", () => {
    applyOverrides({ "ircx-dark": { "--accent": "#ff00ff" } });
    applyTheme(builtIn("ircx-dark"));
    expect(root.style.getPropertyValue("--accent")).toBe("#ff00ff");

    applyTheme(null);
    expect(root.style.getPropertyValue("--accent")).toBe("");
  });

  /** This edit names a token the theme already states, so undoing it leaves no
   * property that has to be removed — and the inline declaration still has to
   * come back to exactly what the theme wrote, holding nothing of the edit. */
  it("leaves no property behind when the edit is undone", () => {
    applyTheme(dense);
    applyOverrides({ dense: { "--surface-base": "#0a0b0c" } });
    applyOverrides({});

    const properties = Array.from({ length: root.style.length }, (_, i) => root.style.item(i));
    expect(properties.filter((name) => name.startsWith("--")).sort()).toEqual([
      "--surface-base",
      "--timeline-block-gap",
    ]);
    expect(root.style.getPropertyValue("--surface-base")).toBe("#010203");
  });
});

describe("the stored density", () => {
  afterEach(() => localStorage.removeItem("ircx.density"));

  it("is remembered", () => {
    storeDensity("read");
    expect(storedDensity()).toBe("read");
  });

  /** The value is whatever was in localStorage when the window opened, which a
   * downgrade or a typo can make meaningless. */
  it("refuses a name that is not a density", () => {
    localStorage.setItem("ircx.density", "cosy");
    expect(storedDensity()).toBeNull();
  });

  it("is null before anything chose one", () => {
    expect(storedDensity()).toBeNull();
  });
});
