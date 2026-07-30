import { describe, expect, it } from "vitest";
import { nicknameProblem } from "../nickname";

const LIBERA = 16;

describe("nicknameProblem", () => {
  it("accepts an ordinary nickname", () => {
    expect(nicknameProblem("sable", LIBERA)).toBeNull();
  });

  it("accepts the punctuation RFC 2812 calls special", () => {
    expect(nicknameProblem("[sable]_^{|}\\`", LIBERA)).toBeNull();
  });

  it("accepts digits and hyphens after the first character", () => {
    expect(nicknameProblem("sable-2", LIBERA)).toBeNull();
  });

  it("asks for a nickname rather than calling an empty box invalid", () => {
    expect(nicknameProblem("", LIBERA)).toBe(
      "Choose a nickname — it is how everyone on the network sees you.",
    );
  });

  it("names the leading digit as the problem", () => {
    expect(nicknameProblem("9lives", LIBERA)).toContain("cannot start with a digit");
  });

  it("names the leading hyphen as the problem", () => {
    expect(nicknameProblem("-sable", LIBERA)).toContain("cannot start with a hyphen");
  });

  it("suggests an underscore when the nickname has a space in it", () => {
    expect(nicknameProblem("sable the cat", LIBERA)).toContain("underscore");
  });

  it("quotes the character that is not allowed and lists the ones that are", () => {
    const problem = nicknameProblem("sable!", LIBERA);
    expect(problem).toContain('"!"');
    expect(problem).toContain("Letters, digits and");
  });

  it("rejects a leading character that is neither letter nor special", () => {
    expect(nicknameProblem("!sable", LIBERA)).toContain("Start with a letter");
  });

  it("treats a non-ASCII letter as a character IRC does not carry", () => {
    expect(nicknameProblem("sablé", LIBERA)).toContain('"é"');
  });

  it("accepts a nickname exactly at the limit", () => {
    expect(nicknameProblem("a".repeat(LIBERA), LIBERA)).toBeNull();
  });

  it("gives both the limit and the length when the nickname is too long", () => {
    const problem = nicknameProblem("a".repeat(19), LIBERA);
    expect(problem).toContain("16 characters");
    expect(problem).toContain("is 19");
  });

  it("applies the limit it is given, not one of its own", () => {
    expect(nicknameProblem("a".repeat(19), 30)).toBeNull();
  });
});
