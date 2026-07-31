import { contrast, luminance, toHex } from "./contrast";

/**
 * The arithmetic above `toHex` reads exactly six digits, so anything a person
 * types into the editor has to be widened, narrowed or refused before it gets
 * there.
 */
describe("toHex", () => {
  it("widens a three-digit shorthand", () => {
    expect(toHex("#abc")).toBe("#aabbcc");
  });

  /** What that colour actually looks like is a question about the surface
   * behind it, which is `flatten`'s to answer rather than this one's. */
  it("drops the alpha of an eight-digit hex", () => {
    expect(toHex("#aabbccdd")).toBe("#aabbcc");
  });

  /** The failure the whole function exists to stop: `channels` reads a sixth
   * digit that is not there, the ratio built on it comes back NaN, and every
   * `>= 4.5` downstream then reads false without anyone having decided it
   * should. */
  it("keeps a shorthand from going NaN through the ratio", () => {
    expect(luminance("#fff")).toBeNaN();

    expect(luminance(toHex("#fff")!)).toBeCloseTo(1);
    expect(contrast(toHex("#fff")!, "#000000")).toBeCloseTo(21);
  });

  /** A warning system that silently stops warning is worse than one that
   * admits it cannot tell. */
  it.each(["rgb(0 0 0)", "grey", "#ff", "#12345", "not a colour"])(
    "cannot read %s and says so rather than guessing",
    (value) => {
      expect(toHex(value)).toBeNull();
    },
  );
});
