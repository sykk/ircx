import { beforeEach, describe, expect, it } from "vitest";
import { formatClock } from "@/components/timeline/rows";
import {
  CLOCK_FORMATS,
  DEFAULT_PRESENTATION,
  sanitisePresentation,
  storePresentation,
  storedPresentation,
} from "./presentation";

describe("sanitisePresentation", () => {
  it("takes a setting that was written by this app", () => {
    expect(
      sanitisePresentation({ spine: false, clock: "12h", nickBrackets: true }),
    ).toEqual({ spine: false, clock: "12h", nickBrackets: true });
  });

  it("keeps the fields it recognises when a neighbour is wrong", () => {
    expect(
      sanitisePresentation({ spine: false, clock: "half past", nickBrackets: true }),
    ).toEqual({ spine: false, clock: DEFAULT_PRESENTATION.clock, nickBrackets: true });
  });

  it("refuses a value of the wrong type rather than painting it", () => {
    expect(sanitisePresentation({ spine: "yes", nickBrackets: 1 })).toEqual(DEFAULT_PRESENTATION);
  });

  it("falls back on anything that is not an object", () => {
    for (const raw of [null, "spine", 3, [], undefined]) {
      expect(sanitisePresentation(raw)).toEqual(DEFAULT_PRESENTATION);
    }
  });
});

describe("storedPresentation", () => {
  beforeEach(() => localStorage.clear());

  it("returns what the last session stored", () => {
    storePresentation({ spine: false, clock: "off", nickBrackets: true });
    expect(storedPresentation()).toEqual({ spine: false, clock: "off", nickBrackets: true });
  });

  it("opens on the defaults when nothing was stored", () => {
    expect(storedPresentation()).toEqual(DEFAULT_PRESENTATION);
  });

  it("opens on the defaults rather than throwing on a blob that will not parse", () => {
    localStorage.setItem("ircx.presentation", "{not json");
    expect(storedPresentation()).toEqual(DEFAULT_PRESENTATION);
  });
});

/* The examples in CLOCK_FORMATS are written out because presentation.ts cannot
 * import from the timeline, which is above it. This is the assertion that keeps
 * the label in the appearance sheet honest about what the format prints. */
describe("CLOCK_FORMATS", () => {
  const sample = new Date(2026, 0, 5, 14, 32, 7).toISOString();

  it("shows what each format prints", () => {
    for (const { id, example } of CLOCK_FORMATS) {
      expect(formatClock(sample, id)).toBe(example);
    }
  });

  it("offers every format formatClock accepts", () => {
    expect(CLOCK_FORMATS.map((format) => format.id)).toEqual([
      "24h",
      "24h-seconds",
      "12h",
      "off",
    ]);
  });
});
