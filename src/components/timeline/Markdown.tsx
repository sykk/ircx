import { Fragment, useState } from "react";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { LeavesTheClient, leavingLabel } from "@/components/common/LeavesTheClient";
import { openExternal } from "@/lib/ipc";
import { parseMarkdown, type Block, type Span } from "@/lib/markdown";

/**
 * The same message flattened to one line of text, for excerpts that quote a
 * message rather than render it. A dimmed line at reduced weight can carry
 * neither the syntax nor the emphasis, so `**do not**` reads as `do not` and a
 * fenced paste contributes its code without its fence.
 */
export function plainText(text: string): string {
  return parseMarkdown(stripIrcFormatting(text))
    .map(blockText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockText(block: Block): string {
  return block.type === "code" ? block.text : spansText(block.spans);
}

function spansText(spans: Span[]): string {
  return spans
    .map((span) => {
      if (span.type === "text" || span.type === "code") return span.text;
      // A link is written out in full, so its text is its destination.
      if (span.type === "link") return span.url;
      return spansText(span.spans);
    })
    .join("");
}

export function Markdown({ text, urls = [] }: { text: string; urls?: readonly string[] }) {
  return (
    <>
      {parseMarkdown(stripIrcFormatting(text), urls).map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </>
  );
}

/** Past this a paste is scenery; it scrolls in place rather than pushing the
 * conversation off screen. */
const PASTE_MAX_PX = 260;

function BlockView({ block }: { block: Block }) {
  if (block.type === "code") {
    const lines = block.text === "" ? 0 : block.text.split("\n").length;
    return (
      <div
        className="my-1 overflow-hidden rounded-[var(--radius-sm)] border"
        style={{ background: "var(--surface-raised)", borderColor: "var(--border-subtle)" }}
      >
        <div
          className="flex justify-between px-2 py-0.5 text-[11px]"
          style={{ color: "var(--text-faint)" }}
        >
          <span className="font-[family-name:var(--font-mono)]">{block.lang ?? ""}</span>
          <span>
            {lines} line{lines === 1 ? "" : "s"}
          </span>
        </div>
        <pre
          className="selectable overflow-auto px-2 pb-1.5 font-[family-name:var(--font-mono)] text-[12px] leading-[1.45]"
          style={{ maxHeight: PASTE_MAX_PX, color: "var(--text-secondary)" }}
        >
          <code>{block.text}</code>
        </pre>
      </div>
    );
  }
  // Inline rather than a paragraph so a caller can put a prefix such as a
  // notice's `-nick-` on the same line as the first word.
  return (
    <span className="whitespace-pre-wrap break-words">
      <Spans spans={block.spans} />
    </span>
  );
}

/**
 * Written out in full and opened outside this window. An anchor with an `href`
 * would be a navigation the webview might take, so there is no `href` at all.
 * That gives up middle-click and "copy link address", which is the trade.
 */
function Link({ url }: { url: string }) {
  /* A link that will not open has to say so where the reader is looking. The
     only report before this was a `console.warn`, which is invisible to anyone
     not holding devtools open — the same mistake as swallowing the rejection,
     one step further along. #167 was a scope the opener refused, and nothing
     on screen said a word about it. */
  const [refused, setRefused] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        aria-label={leavingLabel(url)}
        onClick={() => {
          setRefused(null);
          void openExternal(url).catch((reason: unknown) => {
            setRefused(String(reason));
          });
        }}
        /* A button is inline-block and sizes to its content, so a long URL
           ignored the paragraph's wrapping and ran out of the pane — over the
           column beside it in a split. Capped and broken anywhere. */
        className="max-w-full cursor-pointer text-left break-all underline decoration-from-font underline-offset-2 hover:decoration-2"
        style={{ color: "var(--accent)" }}
      >
        {url}
        <LeavesTheClient />
      </button>
      {refused !== null && (
        <span className="ml-1.5 text-[11px]" style={{ color: "var(--danger)" }}>
          could not open — {refused}
        </span>
      )}
    </>
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <Fragment key={i}>{renderSpan(span)}</Fragment>
      ))}
    </>
  );
}

function renderSpan(span: Span) {
  switch (span.type) {
    case "text":
      return span.text;
    case "code":
      return (
        <code
          className="rounded-[var(--radius-sm)] px-1 py-px font-[family-name:var(--font-mono)] text-[12px]"
          style={{ background: "var(--surface-raised)", color: "var(--text-primary)" }}
        >
          {span.text}
        </code>
      );
    case "strong":
      return (
        <strong className="font-semibold">
          <Spans spans={span.spans} />
        </strong>
      );
    case "em":
      return (
        <em className="italic">
          <Spans spans={span.spans} />
        </em>
      );
    case "link":
      return <Link url={span.url} />;
    case "strike":
      return (
        <s style={{ color: "var(--text-muted)" }}>
          <Spans spans={span.spans} />
        </s>
      );
  }
}
