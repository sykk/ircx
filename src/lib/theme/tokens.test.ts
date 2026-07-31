import { REQUIRED_TOKENS, TOKEN_CATALOGUE, TOKEN_GROUPS } from "./tokens";

/**
 * REQUIRED_TOKENS is derived from the dark theme's stylesheet and the
 * catalogue is written out by hand, so the two drift the moment either one
 * changes alone. Both directions matter and for different reasons: a token in
 * the theme and not in the catalogue is a token the editor silently cannot
 * change, and a token in the catalogue and not in the theme is a control that
 * paints a property nothing reads.
 */
describe("the token catalogue", () => {
  it("has an entry for every token the dark theme defines", () => {
    expect(REQUIRED_TOKENS.filter((token) => !(token in TOKEN_CATALOGUE))).toEqual([]);
  });

  it("has an entry for nothing else", () => {
    const required = new Set(REQUIRED_TOKENS);
    expect(Object.keys(TOKEN_CATALOGUE).filter((token) => !required.has(token))).toEqual([]);
  });

  /** A group the editor does not lay a section out for is a token that never
   * reaches the screen. */
  it("files every token under a section the editor draws", () => {
    const groups = new Set(TOKEN_GROUPS);
    const stray = Object.entries(TOKEN_CATALOGUE)
      .filter(([, spec]) => !groups.has(spec.group))
      .map(([token]) => token);

    expect(stray).toEqual([]);
  });
});
