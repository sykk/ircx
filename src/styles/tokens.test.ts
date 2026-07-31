import { readFileSync, readdirSync } from "node:fs";
import {
  AA_BODY,
  COOL_MAX,
  COOL_MIN,
  DISABLED_FLOOR,
  SURFACES,
  contrast,
  flatten,
  hue,
} from "@/lib/theme/contrast";

// readability/READABILITY.md finding 1: an unconstrained nick palette collides
// with the security and connection colours, and a nick rendered in the colour
// that means "error" is a lie the user cannot see. These assert the constraint
// rather than the specific values, so retuning a hue stays cheap and stepping
// outside the band does not.
//
// Every theme shipped is held to it, not just the two that were here first: a
// theme is the one thing that can put a nick back on top of --danger.

// Relative to the vitest root, which is the project root.
const THEMES_DIR = "src/styles/themes";

const THEMES = readdirSync(THEMES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    id: entry.name,
    css: readFileSync(`${THEMES_DIR}/${entry.name}/theme.css`, "utf8"),
  }));

function readVars(css: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(
    /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
  )) {
    if (name!.startsWith(prefix)) out[name!] = value!;
  }
  return out;
}

/** Every custom property in the sheet, whatever kind of value it holds.
 * `readVars` only sees hex, which is the point of it; layout is not a colour. */
function readAll(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

function readNumber(css: string, name: string): number {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)\\s*;`).exec(css);
  if (!match) throw new Error(`missing --${name}`);
  return Number(match[1]);
}

it("ships the two built-in themes", () => {
  expect(THEMES.map((theme) => theme.id)).toEqual(
    expect.arrayContaining(["ircx-dark", "ircx-light"]),
  );
});

describe.each(THEMES)("$id nick palette", ({ css }) => {
  const nicks = readVars(css, "nick-");
  const all = readVars(css, "");
  const surfaceValues = SURFACES.map((surface) => {
    const value = all[surface];
    if (!value) throw new Error(`missing --${surface}`);
    return value;
  });

  it("defines all ten entries", () => {
    expect(Object.keys(nicks)).toHaveLength(10);
  });

  it.each(Object.entries(nicks))("%s sits in the cool band", (_name, value) => {
    const h = hue(value);
    expect(h).toBeGreaterThanOrEqual(COOL_MIN);
    expect(h).toBeLessThanOrEqual(COOL_MAX);
  });

  it.each(Object.entries(nicks))("%s clears AA on every surface", (_name, value) => {
    for (const surface of surfaceValues) {
      expect(contrast(value, surface)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("keeps every nick clear of the status colours", () => {
    const reserved = ["state-connected", "state-connecting", "state-error", "danger", "success", "warning"]
      .map((n) => all[n])
      .filter((v): v is string => Boolean(v));

    for (const [name, value] of Object.entries(nicks)) {
      for (const status of reserved) {
        const apart = Math.abs(hue(value) - hue(status));
        expect(Math.min(apart, 360 - apart), `--${name} vs ${status}`).toBeGreaterThan(20);
      }
    }
  });
});

// The disabled fraction is a token because a ratio tuned against one palette is
// wrong against the other: 0.4 read as quiet on the dark surface and as empty
// on the light one. The rule that produced each theme's value is the floor
// below, not a preference, so a theme that retunes it has something to check
// against.
// The timeline's ladder and density were inline styles until #73, which put
// them out of a theme's reach entirely. Now that they are tokens, a theme that
// forgets one lays the pane out with an undefined column — the same failure
// #70-72 were, arriving through a property rather than a colour. The names come
// from the dark theme because that is what REQUIRED_TOKENS is derived from.
const LAYOUT_TOKENS = Object.keys(
  readAll(THEMES.find((theme) => theme.id === "ircx-dark")!.css),
).filter((name) => name.startsWith("timeline-"));

describe.each(THEMES)("$id timeline layout", ({ css }) => {
  const all = readAll(css);

  it("declares the same set the dark theme does", () => {
    expect(Object.keys(all).filter((name) => name.startsWith("timeline-")).sort()).toEqual(
      [...LAYOUT_TOKENS].sort(),
    );
  });

  // A length or a bare ratio. Anything else — a colour, a keyword, a var()
  // chain pointing somewhere else — collapses a column rather than restyling
  // one, and does it silently.
  it.each(LAYOUT_TOKENS)("gives --%s a measure to lay out with", (name) => {
    expect(all[name]).toMatch(/^\d+(\.\d+)?(px|rem|em|ch)?$/);
  });
});

describe.each(THEMES)("$id disabled controls", ({ css }) => {
  const all = readVars(css, "");
  const opacity = readNumber(css, "disabled-opacity");

  /** Where a disabled control actually sits: the onboarding button on the base
   * surface, the composer's send affordance on the raised one. */
  it.each(["surface-base", "surface-raised"])("stay visible on --%s", (surface) => {
    const accent = all["accent"];
    const behind = all[surface];
    if (!accent || !behind) throw new Error(`missing --accent or --${surface}`);

    expect(contrast(flatten(accent, behind, opacity), behind)).toBeGreaterThanOrEqual(
      DISABLED_FLOOR,
    );
  });
});
