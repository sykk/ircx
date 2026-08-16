import { Fragment, useState } from "react";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { LeavesTheClient, leavingLabel } from "@/components/common/LeavesTheClient";
import { openExternal } from "@/lib/ipc";
import { parseMarkdown, type Block, type Span } from "@/lib/markdown";
import { NO_HIGHLIGHT, splitOnHighlight, type HighlightRule } from "@/store/selectors";
import { describeUrl } from "@/lib/url";

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
  if (block.type === "code") return block.text;
  if (block.type === "list") return block.items.map(spansText).join(" ");
  return spansText(block.spans);
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

interface MarkdownProps {
  text: string;
  urls?: readonly string[];
  /**
   * The reader's nick, marked wherever it appears in the prose. Null leaves the
   * text alone, which is every render that is not a message addressed to them.
   */
  highlight?: HighlightRule | null;
}

export function Markdown({ text, urls = [], highlight = null }: MarkdownProps) {
  return (
    <>
      {parseMarkdown(stripIrcFormatting(text), urls).map((block, i) => (
        <BlockView key={i} block={block} highlight={highlight} separated={i > 0} />
      ))}
    </>
  );
}

/** Past this a paste is scenery; it scrolls in place rather than pushing the
 * conversation off screen. */
const PASTE_MAX_PX = 260;

function BlockView({
  block,
  highlight,
  separated,
}: {
  block: Block;
  highlight: HighlightRule | null;
  separated: boolean;
}) {
  if (block.type === "code") {
    const lines = block.text === "" ? 0 : block.text.split("\n").length;
    return (
      <div
        className={`${separated ? "mt-2" : "mt-1"} overflow-hidden rounded-[var(--radius-sm)] border`}
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
  if (block.type === "quote") {
    return (
      <blockquote
        className={`${separated ? "mt-2" : "mt-1"} block whitespace-pre-wrap border-l pl-2`}
        style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
      >
        <Spans spans={block.spans} highlight={highlight} />
      </blockquote>
    );
  }
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List
        className={`${separated ? "mt-2" : "mt-1"} block space-y-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
      >
        {block.items.map((item, i) => (
          <li key={i}>
            <Spans spans={item} highlight={highlight} />
          </li>
        ))}
      </List>
    );
  }
  // Inline rather than a paragraph so a caller can put a prefix such as a
  // notice's `-nick-` on the same line as the first word.
  return (
    <span className={`${separated ? "mt-2 block" : ""} whitespace-pre-wrap break-words`}>
      <Spans spans={block.spans} highlight={highlight} />
    </span>
  );
}

/* A button is inline-block and sizes to its content, so a long URL ignored the
   paragraph's wrapping and ran out of the pane — over the column beside it in a
   split. Capped and broken anywhere. A chip rarely reaches that width now, but a
   host on its own still can in a narrow split. */
const LINK = "max-w-full cursor-pointer text-left break-all";

/** What a URL with no host to lead with falls back to: written out whole. */
const WHOLE = {
  className: "underline decoration-from-font underline-offset-2 hover:decoration-2",
  style: { color: "var(--accent)" },
};

const CHIP = {
  className:
    "rounded-[var(--radius-sm)] border px-1 py-px align-baseline font-[family-name:var(--font-mono)] text-[12px] hover:bg-[var(--surface-hover)]",
  style: { background: "var(--surface-raised)", borderColor: "var(--border-default)" },
};

/**
 * Opened outside this window. An anchor with an `href` would be a navigation
 * the webview might take, so there is no `href` at all. That gives up
 * middle-click and "copy link address", which is the trade.
 *
 * The host leads at full weight and the path follows behind it, quieter and
 * elided once long — `readability/READABILITY.md` study 07, which is about the
 * kinds of thing IRC carries that are not prose and should not be set as prose.
 *
 * The text no longer states the destination character for character, which was
 * a property this had and gave up. What it states is the host, resolved by
 * `URL` rather than skimmed off the front of a string — which is why the short
 * form is the harder of the two to spoof. The whole URL stays in the accessible
 * name and the tooltip.
 */
function Link({ url }: { url: string }) {
  const label = describeUrl(url);
  const look = label === null ? WHOLE : CHIP;
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
        data-link-url={url}
        aria-label={leavingLabel(url)}
        title={url}
        onClick={() => {
          setRefused(null);
          void openExternal(url).catch((reason: unknown) => {
            setRefused(String(reason));
          });
        }}
        className={`${LINK} ${look.className}`}
        style={look.style}
      >
        {label === null ? (
          url
        ) : (
          <>
            <span style={{ color: "var(--accent)" }}>{label.host}</span>
            {label.tail !== "" && <span style={{ color: "var(--text-muted)" }}>{label.tail}</span>}
          </>
        )}
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

function Spans({ spans, highlight }: { spans: Span[]; highlight: HighlightRule | null }) {
  return (
    <>
      {spans.map((span, i) => (
        <Fragment key={i}>{renderSpan(span, highlight)}</Fragment>
      ))}
    </>
  );
}

/**
 * The reader's own nick where it appears in what somebody wrote.
 *
 * Prose only. A nick inside a paste or a `code` span is a string somebody
 * quoted, not a person being addressed, and marking it would make the client
 * claim a piece of data was about you.
 */
export function Mentioned({
  text,
  highlight,
}: {
  text: string;
  highlight: HighlightRule | null;
}) {
  const runs = splitOnHighlight(text, highlight ?? NO_HIGHLIGHT);
  if (runs.length === 1) return <>{text}</>;

  return (
    <>
      {runs.map((run, i) =>
        run.mine ? (
          <mark
            key={i}
            className="rounded-[var(--radius-sm)] px-1 font-semibold"
            style={{ background: "var(--accent-muted)", color: "var(--text-primary)" }}
          >
            {run.text}
          </mark>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

function renderSpan(span: Span, highlight: HighlightRule | null) {
  switch (span.type) {
    case "text":
      return <Mentioned text={span.text} highlight={highlight} />;
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
          <Spans spans={span.spans} highlight={highlight} />
        </strong>
      );
    case "em":
      return (
        <em className="italic">
          <Spans spans={span.spans} highlight={highlight} />
        </em>
      );
    case "link":
      return <Link url={span.url} />;
    case "strike":
      return (
        <s style={{ color: "var(--text-muted)" }}>
          <Spans spans={span.spans} highlight={highlight} />
        </s>
      );
  }
}
