import { describe, expect, it } from "vitest";
import { catalogue } from "./load";
import { PRESETS } from "./presets";
import { CLOCK_FORMATS } from "./presentation";
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
    expect(PROSE_FACES.map((face) => face.id)).toContain(preset.faces.prose);
    expect(MONO_FACES.map((face) => face.id)).toContain(preset.faces.mono);
  });

  /** The scale is an accessibility setting somebody chose for their eyes. No
   * look is worth resizing a window on their behalf, so `faces` is the whole of
   * what a preset may say about type. */
  it.each(PRESETS)("$name leaves the window scale alone", (preset) => {
    expect(Object.keys(preset.faces).sort()).toEqual(["mono", "prose"]);
  });
});

describe("the classic preset", () => {
  const classic = PRESETS.find((preset) => preset.id === "classic")!;

  it("is the old layout, whole", () => {
    expect(classic.presentation).toEqual({
      spine: false,
      clock: "24h-seconds",
      nickBrackets: true,
    });
    expect(classic.faces.prose).toBe("mono");
  });
});
