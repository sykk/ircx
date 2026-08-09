import { describe, expect, it } from "vitest";
import { catalogue } from "./load";
import { PRESETS } from "./presets";
import { CLOCK_FORMATS, CLOCK_SIDES } from "./presentation";
import { MONO_FACES, PROSE_FACES } from "./typography";

const installed = new Set(catalogue().themes.map((theme) => theme.id));

describe("every preset", () => {
  /** A preset naming a theme that is not shipped would fall through to the dark
   * one and still write the layout, which reads as the preset half working. */
  it.each(PRESETS)("$name names a theme that loads", (preset) => {
    expect(installed).toContain(preset.theme);
  });

  it.each(PRESETS)("$name names settings the sheet also offers", (preset) => {
    expect(CLOCK_FORMATS.map((format) => format.id)).toContain(preset.presentation.clock);
    expect(CLOCK_SIDES.map((side) => side.id)).toContain(preset.presentation.clockSide);
    expect(PROSE_FACES.map((face) => face.id)).toContain(preset.faces.prose);
    expect(MONO_FACES.map((face) => face.id)).toContain(preset.faces.mono);
  });

  /** The scale is an accessibility setting somebody chose for their eyes. No
   * look is worth resizing a window on their behalf, so `faces` is the whole of
   * what a preset may say about type. */
  it.each(PRESETS)("$name leaves the window scale alone", (preset) => {
    expect(Object.keys(preset.faces).sort()).toEqual(["mono", "prose"]);
  });

  /** The name in front of every line decides how much of the window a
   * conversation takes rather than what it looks like, and somebody who reads a
   * channel that way reads every look that way. A preset states the other four
   * settings and says nothing about this one. */
  it.each(PRESETS)("$name leaves the name on every line alone", (preset) => {
    expect(Object.keys(preset.presentation)).not.toContain("nickEveryLine");
  });
});

describe("the classic preset", () => {
  const classic = PRESETS.find((preset) => preset.id === "classic")!;

  it("is the old layout, whole", () => {
    expect(classic.presentation).toEqual({
      spine: false,
      clock: "24h-seconds",
      clockSide: "left",
      nickBrackets: true,
    });
    expect(classic.faces.prose).toBe("mono");
  });
});
