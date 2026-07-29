import { readFileSync } from "node:fs";

// readability/READABILITY.md finding 1: an unconstrained nick palette collides
// with the security and connection colours, and a nick rendered in the colour
// that means "error" is a lie the user cannot see. These assert the constraint
// rather than the specific values, so retuning a hue stays cheap and stepping
// outside the band does not.

// Relative to the vitest root, which is the project root.
const css = readFileSync("src/styles/tokens.css", "utf8");

const COOL_MIN = 180;
const COOL_MAX = 350;
const AA_BODY = 4.5;

function blockFor(selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`tokens.css has no ${selector} block`);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
}

function readVars(block: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(
    /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
  )) {
    if (name!.startsWith(prefix)) out[name!] = value!;
  }
  return out;
}

function channels(hex: string): [number, number, number] {
  const n = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sextant =
    max === r ? (((g - b) / delta) % 6) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return ((sextant * 60) % 360 + 360) % 360;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = [
  {
    name: "dark",
    selector: ':root[data-theme="ircx-dark"]',
    surfaces: ["surface-base", "surface-sidebar", "surface-raised", "surface-hover", "surface-active"],
  },
  {
    name: "light",
    selector: ':root[data-theme="ircx-light"]',
    surfaces: ["surface-base", "surface-sidebar", "surface-raised", "surface-hover", "surface-active"],
  },
];

describe.each(THEMES)("$name nick palette", ({ selector, surfaces }) => {
  const block = blockFor(selector);
  const nicks = readVars(block, "nick-");
  const all = readVars(block, "");
  const surfaceValues = surfaces.map((s) => {
    const v = all[s];
    if (!v) throw new Error(`missing --${s}`);
    return v;
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
