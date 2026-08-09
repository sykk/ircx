import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import {
  adoptAppearance,
  applyOpeningTheme,
  selectPresentation,
  selectTheme,
} from "./session";
import { catalogue } from "./load";
import { storedPresentation } from "./presentation";
import { rememberInstalled, rememberedInstalled } from "./remembered";
import lightStylesheet from "@/styles/themes/ircx-light/theme.css?raw";

const { zoomMock } = vi.hoisted(() => ({ zoomMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/ipc", () => ({
  ipc: { listThemes: () => Promise.resolve([]) },
  onThemesChanged: () => Promise.resolve(() => {}),
  setWindowZoom: zoomMock,
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
  vi.clearAllMocks();
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

describe("what the timeline draws", () => {
  it("opens on what the last session chose", () => {
    localStorage.setItem(
      "ircx.presentation",
      JSON.stringify({
        spine: false,
        clock: "12h",
        clockSide: "left",
        nickBrackets: true,
        nickEveryLine: true,
      }),
    );

    applyOpeningTheme();

    expect(useAppStore.getState().presentation).toEqual({
      spine: false,
      clock: "12h",
      clockSide: "left",
      nickBrackets: true,
      nickEveryLine: true,
    });
  });

  /* Held as one blob, so a change that did not merge would reset whichever of
   * the settings was not being set. */
  it("merges one setting over the ones it was not given", () => {
    useAppStore.setState({
      presentation: {
        spine: false,
        clock: "12h",
        clockSide: "left",
        nickBrackets: true,
        nickEveryLine: true,
      },
    });

    selectPresentation({ clock: "off" });

    expect(useAppStore.getState().presentation).toEqual({
      spine: false,
      clock: "off",
      clockSide: "left",
      nickBrackets: true,
      nickEveryLine: true,
    });
    expect(storedPresentation()).toEqual({
      spine: false,
      clock: "off",
      clockSide: "left",
      nickBrackets: true,
      nickEveryLine: true,
    });
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

/**
 * The client and the settings window are two webviews on one origin, so both
 * read the same localStorage and only the one that made a change has it on the
 * screen. These are the two halves of catching the other one up.
 */
describe("the appearance the last run left", () => {
  beforeEach(() => {
    useAppStore.setState({ themes: catalogue().themes });
  });

  /* Every appearance setting comes back from localStorage, so this is where
   * the opening paint is held to reading each one of them. */
  it("paints what the last run wrote, setting by setting", () => {
    localStorage.setItem("ircx.theme", "ircx-light");
    localStorage.setItem("ircx.density", "compact");
    localStorage.setItem("ircx.typography", JSON.stringify({ prose: "georgia", mono: "courier", zoom: 1.25 }));
    localStorage.setItem("ircx.presentation", JSON.stringify({ ...storedPresentation(), spine: false }));
    localStorage.setItem(
      "ircx.theme.overrides",
      JSON.stringify({ "ircx-light": { "--accent": "#3fb950" } }),
    );

    adoptAppearance();

    const style = document.documentElement.style;
    expect(surface()).toBe("#ffffff");
    expect(style.getPropertyValue("--accent")).toBe("#3fb950");
    expect(style.getPropertyValue("--timeline-block-gap")).toBe("6px");
    expect(style.getPropertyValue("--font-ui")).toContain("Georgia");
    expect(style.getPropertyValue("--font-mono")).toContain("Courier");
    expect(useAppStore.getState().presentation.spine).toBe(false);
    expect(zoomMock).toHaveBeenCalledWith(1.25);
  });

  /** The catalogue is a fact about the disk, and by the time anything repaints
   * it has usually read more of it. A repaint that also republished the list
   * would throw away every theme on disk the moment a density changed. */
  it("leaves the themes it can see alone", () => {
    const themes = [...useAppStore.getState().themes, { ...catalogue([harbour]).themes.at(-1)! }];
    useAppStore.setState({ themes });

    adoptAppearance();

    expect(useAppStore.getState().themes).toHaveLength(themes.length);
  });
});
