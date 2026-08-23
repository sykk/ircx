/**
 * The subset of Markdown a chat line can carry: bold, italic, strike, spoiler,
 * inline code and fenced code. Parsing stops at an AST; nothing here produces
 * HTML, because message text arrives from the network and never reaches
 * innerHTML.
 */

export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; spans: Span[] }
  | { type: "em"; spans: Span[] }
  | { type: "strike"; spans: Span[] }
  | { type: "spoiler"; spans: Span[] }
  /** A bare URL, written out in full. There is no form where the text differs
   * from the destination: that is how a reader is made to click something they
   * did not intend, and in a message from a stranger the destination is the
   * only thing they can check. */
  | { type: "link"; url: string };

export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "quote"; spans: Span[] }
  | { type: "list"; ordered: boolean; items: Span[][] }
  | { type: "code"; lang: string | null; text: string };

const FENCE = /^\s*```(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/**
 * `urls` are the links to write out as links. They are not found here: the
 * backend already decided what a URL is when it built the message's
 * attachments, and finding them twice would let the two disagree about where
 * one ends. Anything not in this list stays text.
 */
export function parseMarkdown(text: string, urls: readonly string[] = []): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join("\n");
    paragraph = [];
    if (joined.trim() === "") return;
    blocks.push({ type: "paragraph", spans: parseSpans(joined, urls) });
  };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "") {
      flushParagraph();
      continue;
    }

    const open = FENCE.exec(lines[i]!);
    if (open) {
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
      continue;
    }

    const quote = QUOTE.exec(lines[i]!);
    if (quote) {
      flushParagraph();
      const quoted = [quote[1]!];
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1]!);
        if (!next) break;
        quoted.push(next[1]!);
        i++;
      }
      blocks.push({ type: "quote", spans: parseSpans(quoted.join("\n"), urls) });
      continue;
    }

    const item = LIST.exec(lines[i]!);
    if (item) {
      flushParagraph();
      const ordered = item[2]!.endsWith(".");
      const items = [parseSpans(item[3]!, urls)];
      while (i + 1 < lines.length) {
        const next = LIST.exec(lines[i + 1]!);
        if (!next || next[2]!.endsWith(".") !== ordered) break;
        items.push(parseSpans(next[3]!, urls));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(lines[i]!);
  }

  flushParagraph();
  return blocks;
}

export function parseSpans(text: string, urls: readonly string[] = []): Span[] {
  const spans: Span[] = [];
  let plain = "";

  const flushPlain = () => {
    if (plain === "") return;
    spans.push({ type: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const span = matchAt(text, i, urls);
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

function matchAt(
  text: string,
  i: number,
  urls: readonly string[],
): { span: Span; end: number } | null {
  const ch = text[i];

  // Before the emphasis markers, so a URL containing one is not cut in half,
  // and after nothing, because a URL inside a code span is code.
  const url = urls.find((candidate) => text.startsWith(candidate, i));
  if (url !== undefined) {
    return { span: { type: "link", url }, end: i + url.length };
  }

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

  if (text.startsWith("**", i)) return delimited(text, i, "**", "strong", urls);
  if (text.startsWith("~~", i)) return delimited(text, i, "~~", "strike", urls);
  if (text.startsWith("||", i)) return delimited(text, i, "||", "spoiler", urls);
  if (ch === "*") return delimited(text, i, "*", "em", urls);
  if (ch === "_" && isWordEdge(text[i - 1])) {
    const found = delimited(text, i, "_", "em", urls);
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
  type: "strong" | "em" | "strike" | "spoiler",
  urls: readonly string[],
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
      span: { type, spans: parseSpans(text.slice(from, close), urls) },
      end: close + marker.length,
    };
  }
}
