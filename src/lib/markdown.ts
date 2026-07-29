/**
 * The subset of Markdown a chat line can carry: bold, italic, strike, inline
 * code and fenced code. Parsing stops at an AST; nothing here produces HTML,
 * because message text arrives from the network and never reaches innerHTML.
 */

export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; spans: Span[] }
  | { type: "em"; spans: Span[] }
  | { type: "strike"; spans: Span[] };

export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "code"; lang: string | null; text: string };

const FENCE = /^\s*```(.*)$/;

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n");
    paragraph = [];
    if (joined.trim() === "") return;
    blocks.push({ type: "paragraph", spans: parseSpans(joined) });
  };

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) {
      paragraph.push(lines[i]!);
      continue;
    }
    flushParagraph();

    const lang = open[1]!.trim();
    // An unclosed fence runs to the end of the message rather than reverting to
    // literal text: half a code block is still code the sender meant to show.
    const body: string[] = [];
    for (i++; i < lines.length; i++) {
      if (FENCE.test(lines[i]!)) break;
      body.push(lines[i]!);
    }
    blocks.push({ type: "code", lang: lang || null, text: body.join("\n") });
  }

  flushParagraph();
  return blocks;
}

export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let plain = "";

  const flushPlain = () => {
    if (plain === "") return;
    spans.push({ type: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const span = matchAt(text, i);
    if (!span) {
      plain += text[i];
      i++;
      continue;
    }
    flushPlain();
    spans.push(span.span);
    i = span.end;
  }

  flushPlain();
  return spans;
}

function matchAt(text: string, i: number): { span: Span; end: number } | null {
  const ch = text[i];

  if (ch === "`") {
    let ticks = 0;
    while (text[i + ticks] === "`") ticks++;
    const open = "`".repeat(ticks);
    const close = text.indexOf(open, i + ticks);
    if (close === -1) return null;
    const body = text.slice(i + ticks, close);
    if (body === "") return null;
    return { span: { type: "code", text: body }, end: close + ticks };
  }

  if (text.startsWith("**", i)) return delimited(text, i, "**", "strong");
  if (text.startsWith("~~", i)) return delimited(text, i, "~~", "strike");
  if (ch === "*") return delimited(text, i, "*", "em");
  if (ch === "_" && isWordEdge(text[i - 1])) {
    const found = delimited(text, i, "_", "em");
    if (found && isWordEdge(text[found.end])) return found;
    return null;
  }

  return null;
}

/** `_` inside a word belongs to snake_case, not to emphasis. */
function isWordEdge(ch: string | undefined): boolean {
  return ch === undefined || !/[\w]/.test(ch);
}

function delimited(
  text: string,
  i: number,
  marker: string,
  type: "strong" | "em" | "strike",
): { span: Span; end: number } | null {
  const from = i + marker.length;
  if (/\s/.test(text[from] ?? "")) return null;

  let at = from;
  for (;;) {
    const close = text.indexOf(marker, at);
    if (close === -1 || close === from) return null;
    if (/\s/.test(text[close - 1] ?? "")) {
      at = close + marker.length;
      continue;
    }
    return {
      span: { type, spans: parseSpans(text.slice(from, close)) },
      end: close + marker.length,
    };
  }
}
