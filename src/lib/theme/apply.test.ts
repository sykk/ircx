import { applyDensity, applyTheme } from "./apply";
import { DEFAULT_DENSITY, storeDensity, storedDensity } from "./density";
import { catalogue } from "./load";
import type { Theme } from "./types";

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
    });
    applyTheme(builtIn("ircx-light"));
    applyTheme({
      id: "sparser",
      manifest: { name: "Sparser", author: "a", version: "1.0.0", appearance: "dark" },
      tokens: { "--surface-base": "#040506" },
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
