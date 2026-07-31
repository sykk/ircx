import { describe, expect, it } from "vitest";
import { parseMarkdown, parseSpans, type Span } from "./markdown";

function text(spans: Span[]): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case "text":
        case "code":
          return span.text;
        case "link":
          return span.url;
        default:
          return text(span.spans);
      }
    })
    .join("");
}

describe("parseSpans", () => {
  it("leaves plain text alone", () => {
    expect(parseSpans("no markup here")).toEqual([{ type: "text", text: "no markup here" }]);
  });

  it("reads bold, italic, strike and inline code", () => {
    expect(parseSpans("**b**")).toEqual([
      { type: "strong", spans: [{ type: "text", text: "b" }] },
    ]);
    expect(parseSpans("*i*")).toEqual([{ type: "em", spans: [{ type: "text", text: "i" }] }]);
    expect(parseSpans("~~s~~")).toEqual([
      { type: "strike", spans: [{ type: "text", text: "s" }] },
    ]);
    expect(parseSpans("`c`")).toEqual([{ type: "code", text: "c" }]);
  });

  it("nests emphasis but not code", () => {
    expect(parseSpans("**bold *and* more**")).toEqual([
      {
        type: "strong",
        spans: [
          { type: "text", text: "bold " },
          { type: "em", spans: [{ type: "text", text: "and" }] },
          { type: "text", text: " more" },
        ],
      },
    ]);
    expect(parseSpans("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  it("keeps an unmatched marker as literal text", () => {
    expect(parseSpans("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    expect(parseSpans("**unclosed")).toEqual([{ type: "text", text: "**unclosed" }]);
    expect(parseSpans("a ` tick")).toEqual([{ type: "text", text: "a ` tick" }]);
  });

  it("leaves snake_case alone", () => {
    expect(parseSpans("call read_file_at now")).toEqual([
      { type: "text", text: "call read_file_at now" },
    ]);
    expect(parseSpans("_emphasised_")).toEqual([
      { type: "em", spans: [{ type: "text", text: "emphasised" }] },
    ]);
  });

  it("does not lose characters", () => {
    const source = "**a** _b_ ~~c~~ `d` plain */ 3_4";
    expect(text(parseSpans(source))).toBe("a b c d plain */ 3_4");
  });
});

describe("parseMarkdown", () => {
  it("splits a fenced block out of the surrounding text", () => {
    expect(parseMarkdown("before\n```py\nx = 1\n```\nafter")).toEqual([
      { type: "paragraph", spans: [{ type: "text", text: "before" }] },
      { type: "code", lang: "py", text: "x = 1" },
      { type: "paragraph", spans: [{ type: "text", text: "after" }] },
    ]);
  });

  it("runs an unclosed fence to the end of the message", () => {
    expect(parseMarkdown("look:\n```\nx = 1\ny = 2")).toEqual([
      { type: "paragraph", spans: [{ type: "text", text: "look:" }] },
      { type: "code", lang: null, text: "x = 1\ny = 2" },
    ]);
  });

  it("keeps newlines inside a paragraph", () => {
    const blocks = parseMarkdown("one\ntwo");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "paragraph", spans: [{ type: "text", text: "one\ntwo" }] });
  });

  it("drops nothing on an empty message", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

/**
 * #14. A URL in a message was plain text: reachable only through the
 * attachment line under it, which is a different affordance from clicking the
 * thing you are reading.
 */
describe("links", () => {
  const URL = "https://example.com/a";

  it("writes a known URL out as a link", () => {
    expect(parseSpans(`see ${URL} for it`, [URL])).toEqual([
      { type: "text", text: "see " },
      { type: "link", url: URL },
      { type: "text", text: " for it" },
    ]);
  });

  /** The backend decided what a URL is when it built the attachments. Finding
   * them again here would let the two disagree about where one ends. */
  it("leaves a URL nobody listed as text", () => {
    expect(parseSpans(`see ${URL} for it`, [])).toEqual([
      { type: "text", text: `see ${URL} for it` },
    ]);
  });

  it("links one inside emphasis", () => {
    expect(parseSpans(`*${URL}*`, [URL])).toEqual([
      { type: "em", spans: [{ type: "link", url: URL }] },
    ]);
  });

  /** A URL in code is code. Someone showing a link rather than offering one is
   * the whole reason to write it in backticks. */
  it("leaves one inside code alone", () => {
    expect(parseSpans(`\`${URL}\``, [URL])).toEqual([{ type: "code", text: URL }]);
  });

  /** An underscore or an asterisk in a path is part of the path. Matching the
   * whole URL first is what stops emphasis cutting it in half. */
  it("keeps a URL whole when it contains a marker", () => {
    const tricky = "https://example.com/a_b_c";
    expect(parseSpans(`see ${tricky}`, [tricky])).toEqual([
      { type: "text", text: "see " },
      { type: "link", url: tricky },
    ]);
  });

  it("links every occurrence, not only the first", () => {
    expect(parseSpans(`${URL} and ${URL}`, [URL])).toEqual([
      { type: "link", url: URL },
      { type: "text", text: " and " },
      { type: "link", url: URL },
    ]);
  });
});
