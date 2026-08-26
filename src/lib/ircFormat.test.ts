import { describe, expect, it } from "vitest";
import {
  applyIrcFormat,
  hasIrcFormatting,
  ircColour,
  ircCss,
  ircRuns,
  PLAIN,
  stripIrcFormatting,
} from "./ircFormat";
import { parseMarkdown } from "./markdown";

const BOLD = "\u0002";
const ITALIC = "\u001d";
const UNDERLINE = "\u001f";
const STRIKE = "\u001e";
const MONO = "\u0011";
const REVERSE = "\u0016";
const RESET = "\u000f";
const COLOUR = "\u0003";
const HEX = "\u0004";
const FENCE = "```";

/** A run written as `text/flags+fg,bg`, so an assertion reads the way the line
 * does and a split in the wrong place is visible rather than deduced. */
function shape(text: string): string {
  return ircRuns(text)
    .runs.map(({ text: body, style }) => {
      const flags = [
        style.bold ? "b" : "",
        style.italic ? "i" : "",
        style.underline ? "u" : "",
        style.strike ? "s" : "",
        style.mono ? "m" : "",
        style.reverse ? "r" : "",
      ].join("");
      const colour =
        style.fg === null && style.bg === null
          ? ""
          : `+${style.fg},${style.bg}`;
      return `${body}/${flags}${colour}`;
    })
    .join("|");
}

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

describe("hasIrcFormatting", () => {
  it("answers the same twice running, the pattern behind it being a global one", () => {
    expect(hasIrcFormatting(`${BOLD}loud`)).toBe(true);
    expect(hasIrcFormatting(`${BOLD}loud`)).toBe(true);
    expect(hasIrcFormatting("quiet")).toBe(false);
  });
});

describe("ircRuns", () => {
  it("splits a line where its codes are and drops them", () => {
    expect(shape(`plain ${BOLD}loud${BOLD} again`)).toBe(
      "plain /|loud/b| again/",
    );
  });

  it("toggles rather than nests, so the second code closes the first", () => {
    expect(shape(`${BOLD}a${ITALIC}b${BOLD}c`)).toBe("a/b|b/bi|c/i");
  });

  it("carries a foreground and a background", () => {
    expect(shape(`${COLOUR}4,8warn`)).toBe("warn/+4,8");
  });

  it("reads two digits and then stops", () => {
    expect(shape(`${COLOUR}123`)).toBe("3/+12,null");
  });

  it("takes a comma as text unless a foreground claimed it", () => {
    expect(shape(`${COLOUR},5 no foreground`)).toBe(",5 no foreground/");
  });

  it("treats a bare colour code as a reset of both colours", () => {
    expect(shape(`${COLOUR}4red${COLOUR} plain`)).toBe("red/+4,null| plain/");
  });

  it("resets every code at once", () => {
    expect(shape(`${BOLD}${COLOUR}4a${RESET}b`)).toBe("a/b+4,null|b/");
  });

  it("keeps a code past the palette out of the style", () => {
    expect(shape(`${COLOUR}99back to normal`)).toBe("back to normal/");
  });

  it("threads state from one call into the next", () => {
    const opened = ircRuns(`${COLOUR}4red`);
    expect(ircRuns(" still red", opened.end).runs[0]!.style.fg).toBe(4);
  });

  it("maps a hex colour onto the code nearest it", () => {
    // Full red at mid lightness: hue zero of the wheel, its fourth row.
    expect(ircRuns(`${HEX}FF0000red`).runs[0]!.style.fg).toBe(16 + 3 * 12);
    // No saturation to name a hue with, so it lands on the grey ramp.
    expect(ircRuns(`${HEX}808080grey`).runs[0]!.style.fg).toBe(93);
  });

  it("leaves a truncated hex code as the text it is", () => {
    expect(shape(`${HEX}FF00 half`)).toBe("FF00 half/");
  });

  it("returns nothing at all for an empty line", () => {
    expect(ircRuns("").runs).toEqual([]);
  });
});

describe("ircColour", () => {
  it("resolves every code in the palette to something CSS will take", () => {
    for (let code = 0; code <= 98; code++) {
      expect(ircColour(code), `code ${code}`).toMatch(/^(var\(--|color-mix\()/);
    }
  });

  it("never emits a colour from outside the token system", () => {
    for (let code = 0; code <= 98; code++) {
      expect(ircColour(code), `code ${code}`).not.toMatch(
        /#|\brgba?\(|\bhsla?\(|\boklch\(/,
      );
    }
  });

  it("gives the sixteen classic codes sixteen distinct values", () => {
    const seen = new Set(
      Array.from({ length: 16 }, (_, code) => ircColour(code)),
    );
    expect(seen.size).toBe(16);
  });

  it("draws the middle row of the wheel in the token itself", () => {
    expect(ircColour(16 + 3 * 12)).toBe("var(--danger)");
  });

  it("refuses a code no palette defines", () => {
    expect(ircColour(99)).toBeNull();
    expect(ircColour(-1)).toBeNull();
    expect(ircColour(1.5)).toBeNull();
  });
});

describe("ircCss", () => {
  it("draws nothing at all for a plain run", () => {
    expect(ircCss(PLAIN)).toEqual({});
  });

  it("combines an underline and a strike into one declaration", () => {
    expect(
      ircCss({ ...PLAIN, underline: true, strike: true }).textDecorationLine,
    ).toBe("underline line-through");
  });

  it("swaps the two colours for reverse video", () => {
    const css = ircCss({ ...PLAIN, fg: 4, bg: 8, reverse: true });
    expect(css.color).toBe(ircColour(8));
    expect(css.background).toBe(ircColour(4));
  });

  it("stands the defaults in when reverse has no colours to swap", () => {
    const css = ircCss({ ...PLAIN, reverse: true });
    expect(css.color).toBe("var(--surface-base)");
    expect(css.background).toBe("var(--text-primary)");
  });
});

describe("applyIrcFormat", () => {
  it("splits a paragraph into plain and formatted spans", () => {
    const [block] = applyIrcFormat(
      parseMarkdown(`plain ${BOLD}loud${BOLD} again`),
    );
    expect(block).toEqual({
      type: "paragraph",
      spans: [
        { type: "text", text: "plain " },
        { type: "irc", style: { ...PLAIN, bold: true }, text: "loud" },
        { type: "text", text: " again" },
      ],
    });
  });

  it("carries a colour across a Markdown span opened inside it", () => {
    const block = applyIrcFormat(parseMarkdown(`${COLOUR}4red **and bold** still red`))[0]!;
    const spans = block.type === "paragraph" ? block.spans : [];
    const strong = spans.find((span) => span.type === "strong");
    expect(strong?.type === "strong" && strong.spans[0]).toEqual({
      type: "irc",
      style: { ...PLAIN, fg: 4 },
      text: "and bold",
    });
    expect(spans[spans.length - 1]).toEqual({
      type: "irc",
      style: { ...PLAIN, fg: 4 },
      text: " still red",
    });
  });

  it("strips a paste rather than colouring it", () => {
    const [block] = applyIrcFormat(
      parseMarkdown(`${FENCE}\n${COLOUR}4red()\n${FENCE}`),
    );
    expect(block).toEqual({ type: "code", lang: null, text: "red()" });
  });

  it("keeps a code opened inside a paste in force after it", () => {
    const blocks = applyIrcFormat(
      parseMarkdown(`${FENCE}\n${BOLD}x\n${FENCE}\n\nout here`),
    );
    expect(blocks[1]).toEqual({
      type: "paragraph",
      spans: [
        { type: "irc", style: { ...PLAIN, bold: true }, text: "out here" },
      ],
    });
  });

  it("leaves a line with no codes in it untouched", () => {
    const blocks = parseMarkdown("nothing to see, **emphasis** aside");
    expect(applyIrcFormat(blocks)).toEqual(blocks);
  });

  it("formats the items of a list", () => {
    const [block] = applyIrcFormat(parseMarkdown(`- ${BOLD}one`));
    expect(block).toEqual({
      type: "list",
      ordered: false,
      items: [[{ type: "irc", style: { ...PLAIN, bold: true }, text: "one" }]],
    });
  });
});
