import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { applyOpeningTheme, selectTheme } from "./session";
import { rememberInstalled, rememberedInstalled } from "./remembered";
import lightStylesheet from "@/styles/themes/ircx-light/theme.css?raw";

vi.mock("@/lib/ipc", () => ({
  ipc: { listThemes: () => Promise.resolve([]) },
  onThemesChanged: () => Promise.resolve(() => {}),
}));

/** The light theme's own stylesheet under another name, which is exactly how a
 * theme gets installed: `catalogue` refuses anything short of the full token
 * set, so a two-line stand-in would be dropped as broken and prove nothing. */
const harbour = {
  id: "harbour",
  manifest: JSON.stringify({
    name: "Harbour",
    author: "a walk",
    version: "1.0.0",
    appearance: "light",
  }),
  stylesheet: lightStylesheet,
  uiStylesheet: "",
};

const surface = () => document.documentElement.style.getPropertyValue("--surface-base");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.cssText = "";
});
afterEach(() => localStorage.clear());

describe("the theme a window opens on", () => {
  /** #364. The built-ins are compiled in and paint immediately; a theme from
   * disk took a command to the backend, so the opening paint fell through to
   * the dark theme global.css imports statically and every launch on an
   * installed theme flashed dark first. */
  it("paints an installed theme without waiting for the backend", () => {
    localStorage.setItem("ircx.theme", "harbour");
    rememberInstalled(harbour);

    applyOpeningTheme();

    expect(useAppStore.getState().themeId).toBe("harbour");
    expect(surface()).toBe("#ffffff");
    expect(document.documentElement.dataset.theme).toBe("harbour");
  });

  it("carries that theme's own edits into the same paint", () => {
    localStorage.setItem("ircx.theme", "harbour");
    localStorage.setItem(
      "ircx.theme.overrides",
      JSON.stringify({ harbour: { "--surface-base": "#10233b" } }),
    );
    rememberInstalled(harbour);

    applyOpeningTheme();

    expect(surface()).toBe("#10233b");
  });

  /** The record is what somebody else may have written. A theme that does not
   * load leaves the window on the built-in floor rather than half-painted. */
  it("ignores a remembered theme whose files do not parse", () => {
    localStorage.setItem("ircx.theme", "harbour");
    rememberInstalled({ ...harbour, stylesheet: "this is not a stylesheet" });

    applyOpeningTheme();

    expect(document.documentElement.dataset.theme).toBe("ircx-dark");
  });

  it("opens on a built-in without a record at all", () => {
    localStorage.setItem("ircx.theme", "ircx-light");

    applyOpeningTheme();

    expect(document.documentElement.dataset.theme).toBe("ircx-light");
  });
});

describe("choosing a theme", () => {
  it("forgets the installed one when a built-in is chosen", () => {
    rememberInstalled(harbour);
    useAppStore.setState({ themes: [], themeId: "harbour" });

    selectTheme("ircx-dark");

    expect(rememberedInstalled()).toBeNull();
  });
});
