import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TYPOGRAPHY,
  MONO_FACES,
  PROSE_FACES,
  ZOOM_LEVELS,
  fontTokens,
  sanitiseTypography,
  storeTypography,
  storedTypography,
} from "./typography";

/** What a stack must end in for a face nobody has installed to still resolve. */
const GENERIC = /(sans-serif|serif|monospace|cursive|system-ui)$/;

describe("the faces offered", () => {
  it.each([...PROSE_FACES, ...MONO_FACES].filter((face) => face.stack !== ""))(
    "$name ends in a generic family",
    (face) => {
      expect(face.stack.trim()).toMatch(GENERIC);
    },
  );

  /** The default has to be what tokens.css already declares, or the window
   * changes face the first time anybody opens the appearance sheet. */
  it("defaults to the faces the stylesheet states", () => {
    expect(PROSE_FACES[0]!.id).toBe(DEFAULT_TYPOGRAPHY.prose);
    expect(MONO_FACES[0]!.id).toBe(DEFAULT_TYPOGRAPHY.mono);
  });

  it("offers 100% and defaults to it", () => {
    expect(ZOOM_LEVELS).toContain(1);
    expect(DEFAULT_TYPOGRAPHY.zoom).toBe(1);
  });
});

describe("fontTokens", () => {
  it("paints the two properties tokens.css declares", () => {
    expect(Object.keys(fontTokens(DEFAULT_TYPOGRAPHY)).sort()).toEqual([
      "--font-mono",
      "--font-ui",
    ]);
  });

  /** The terminal look: prose set in the identifiers' face. It follows the mono
   * setting rather than naming a face, so the two cannot disagree. */
  it("gives prose the mono stack when that is what was chosen", () => {
    const tokens = fontTokens({ prose: "mono", mono: "courier", zoom: 1 });

    expect(tokens["--font-ui"]).toBe(tokens["--font-mono"]);
    expect(tokens["--font-ui"]).toContain("Courier");
  });

  it("keeps the two apart otherwise", () => {
    const tokens = fontTokens({ prose: "georgia", mono: "courier", zoom: 1 });

    expect(tokens["--font-ui"]).toContain("Georgia");
    expect(tokens["--font-mono"]).toContain("Courier");
  });
});

describe("sanitiseTypography", () => {
  it("takes a setting this app wrote", () => {
    expect(sanitiseTypography({ prose: "georgia", mono: "courier", zoom: 1.25 })).toEqual({
      prose: "georgia",
      mono: "courier",
      zoom: 1.25,
    });
  });

  it("drops a face that is not offered and keeps the rest", () => {
    expect(sanitiseTypography({ prose: "comic sans", mono: "courier", zoom: 0.9 })).toEqual({
      prose: DEFAULT_TYPOGRAPHY.prose,
      mono: "courier",
      zoom: 0.9,
    });
  });

  /** A scale off the list would go straight to the webview. 40% is a window
   * nobody can read and no control offers a way back out of. */
  it("refuses a scale that is not on the list", () => {
    expect(sanitiseTypography({ zoom: 0.4 }).zoom).toBe(1);
    expect(sanitiseTypography({ zoom: "1.25" }).zoom).toBe(1);
  });

  it("falls back on anything that is not an object", () => {
    for (const raw of [null, "inter", 3, [], undefined]) {
      expect(sanitiseTypography(raw)).toEqual(DEFAULT_TYPOGRAPHY);
    }
  });
});

describe("storedTypography", () => {
  beforeEach(() => localStorage.clear());

  it("returns what the last session stored", () => {
    storeTypography({ prose: "mono", mono: "courier", zoom: 1.1 });

    expect(storedTypography()).toEqual({ prose: "mono", mono: "courier", zoom: 1.1 });
  });

  it("opens on the defaults rather than throwing on a blob that will not parse", () => {
    localStorage.setItem("ircx.typography", "{not json");

    expect(storedTypography()).toEqual(DEFAULT_TYPOGRAPHY);
  });
});
