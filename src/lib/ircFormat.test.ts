import { describe, expect, it } from "vitest";
import { stripIrcFormatting } from "./ircFormat";

const BOLD = "\u0002";
const ITALIC = "\u001d";
const UNDERLINE = "\u001f";
const STRIKE = "\u001e";
const MONO = "\u0011";
const REVERSE = "\u0016";
const RESET = "\u000f";
const COLOUR = "\u0003";
const HEX = "\u0004";

describe("stripIrcFormatting", () => {
  it("takes the bold out of the first line a NickServ user sees", () => {
    expect(stripIrcFormatting(`${BOLD}ircx-e39169${BOLD} is not registered.`)).toBe(
      "ircx-e39169 is not registered.",
    );
  });

  it("removes every emphasis code", () => {
    const line = `${BOLD}b${ITALIC}i${UNDERLINE}u${STRIKE}s${MONO}m${REVERSE}r${RESET}plain`;
    expect(stripIrcFormatting(line)).toBe("biusmrplain");
  });

  it("takes a colour code's arguments with it", () => {
    expect(stripIrcFormatting(`${COLOUR}4,8warning${COLOUR} over`)).toBe("warning over");
    expect(stripIrcFormatting(`${COLOUR}12blue`)).toBe("blue");
    expect(stripIrcFormatting(`${COLOUR}3green`)).toBe("green");
  });

  it("removes a hex colour and its pair", () => {
    expect(stripIrcFormatting(`${HEX}FF0000,00ff00hex${HEX} done`)).toBe("hex done");
  });

  it("leaves the digits that are text alone", () => {
    expect(stripIrcFormatting("build 1234 failed")).toBe("build 1234 failed");
    expect(stripIrcFormatting(`${COLOUR}4 2026 was a year`)).toBe(" 2026 was a year");
  });

  it("keeps a comma no foreground colour claimed", () => {
    expect(stripIrcFormatting(",5 not a background")).toBe(",5 not a background");
    expect(stripIrcFormatting(`${COLOUR},5 no foreground`)).toBe(",5 no foreground");
  });

  it("leaves an unformatted line byte for byte", () => {
    const line = "the writeup is up, ~~half~~ most of it is accurate";
    expect(stripIrcFormatting(line)).toBe(line);
  });
});
