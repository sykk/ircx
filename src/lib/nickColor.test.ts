import { describe, expect, it } from "vitest";
import { nickColor, nickColorIndex, PALETTE_SIZE } from "./nickColor";

describe("nickColor", () => {
  it("returns the same colour for the same nick", () => {
    expect(nickColor("sable")).toBe(nickColor("sable"));
  });

  it("ignores case, because IRC nicks do", () => {
    expect(nickColorIndex("Sable")).toBe(nickColorIndex("sable"));
    expect(nickColorIndex("SABLE")).toBe(nickColorIndex("sable"));
  });

  it("stays inside the declared palette", () => {
    for (const nick of ["a", "sable", "phrack", "nyx", "kade", "pwn-300", "[bot]", ""]) {
      const index = nickColorIndex(nick);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(PALETTE_SIZE);
    }
  });

  it("emits a token reference rather than a colour", () => {
    expect(nickColor("sable")).toMatch(/^var\(--nick-([1-9]|10)\)$/);
  });

  it("spreads a realistic member list over the whole palette", () => {
    const nicks = Array.from({ length: 200 }, (_, i) => `user${i}`);
    const used = new Set(nicks.map(nickColorIndex));
    expect(used.size).toBe(PALETTE_SIZE);
  });

  // Pinned values, not a restatement of the algorithm. The member list and the
  // timeline must agree on every nick; changing the hash renumbers everyone and
  // has to be a deliberate edit to this list.
  it("assigns the indices every surface has to agree on", () => {
    expect(
      ["sable", "phrack", "nyx", "kade", "marrow", "wren", "jolt", "spiral"].map(nickColorIndex),
    ).toEqual([10, 4, 2, 6, 5, 5, 2, 2]);
  });
});
