import { applyTheme } from "./apply";
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
