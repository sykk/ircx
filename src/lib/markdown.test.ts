import { describe, expect, it } from "vitest";
import { parseMarkdown, parseSpans, type Span } from "./markdown";

function text(spans: Span[]): string {
  return spans
    .map((span) => {
      switch (span.type) {
        case "text":
        case "code":
          return span.text;
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
