import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Attachment, AttachmentPreview } from "@/types";
import { LeavesTheClient, leavingLabel } from "@/components/common/LeavesTheClient";
import { ipc, openExternal } from "@/lib/ipc";
import { formatBytes } from "@/lib/bytes";
import { formatClock } from "./rows";

export function formatSize(bytes: bigint | null): string | null {
  return bytes === null ? null : formatBytes(bytes);
}

function filenameOf(attachment: Attachment): string {
  if (attachment.filename) return attachment.filename;
  const path = attachment.url.split("?")[0] ?? attachment.url;
  return path.slice(path.lastIndexOf("/") + 1) || attachment.url;
}

/**
 * What the peek is cut off by, which is the timeline scroller rather than the
 * window: it ends where the composer starts, some 115px short. Measuring
 * against the window instead puts a downwards peek through the bottom of the
 * scroller for any line near the middle of it.
 */
export function clipBox(node: HTMLElement): { top: number; bottom: number } {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== "visible") {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

/** The peek's own margin, padding and border, which come out of the room it has. */
const PEEK_CHROME = 16;
const PEEK_TALLEST = 320;
/** Below this the image says nothing, so it is shown clipped rather than shrunk to a strip. */
const PEEK_SHORTEST = 96;

/**
 * Which side the peek opens on and how tall it may be there. Picking the
 * roomier side is not enough on its own: a pane short enough leaves neither
 * side able to hold the whole image, and the peek then has to be cut down to
 * the room rather than run out through the bottom of the scroller.
 */
export function peekFit(
  anchor: { top: number; bottom: number },
  clip: { top: number; bottom: number },
): { side: "top" | "bottom"; maxHeight: number } {
  const below = clip.bottom - anchor.bottom;
  const above = anchor.top - clip.top;
  const side = below >= above ? "bottom" : "top";
  const room = (side === "bottom" ? below : above) - PEEK_CHROME;
  return { side, maxHeight: Math.max(PEEK_SHORTEST, Math.min(PEEK_TALLEST, room)) };
}

function Paperclip() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11.5 6.5 6.75 11.25a2 2 0 0 1-2.83-2.83l5.4-5.4a3 3 0 0 1 4.24 4.24l-5.4 5.4" />
    </svg>
  );
}

/**
 * An attachment is an offer, not a card: one line, and no bytes cross the
 * network until the reader asks for them. Fetching does not grow the line
 * either — the image is shown by hovering the filename, so a channel where
 * everybody posts screenshots reads as a conversation rather than a gallery.
 *
 * The offer is only made for what can be shown. `mime` is guessed from the
 * extension for exactly this, and every URL in a message is an attachment — so
 * without the check, a link to a news article carries a `fetch` whose only
 * possible answer is that it is not an image.
 */
export function AttachmentLine({ attachment }: { attachment: Attachment }) {
  // Held locally rather than pushed into the store: a preview is session-only,
  // and nothing about the message on disk changed when the user asked for it.
  const [preview, setPreview] = useState<AttachmentPreview | null>(attachment.preview);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [fit, setFit] = useState({ side: "bottom" as "top" | "bottom", maxHeight: PEEK_TALLEST });
  const anchor = useRef<HTMLSpanElement>(null);

  // Measured on the way open rather than on render: the anchor sits wherever the
  // scroller has it, and which side fits changes as the reader scrolls. Running
  // before paint means the peek is never seen on the wrong side first.
  useLayoutEffect(() => {
    if (!peeking || !anchor.current) return;
    setFit(peekFit(anchor.current.getBoundingClientRect(), clipBox(anchor.current)));
  }, [peeking]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await ipc.loadPreview(attachment.url);
      setPreview(loaded.preview);
      setFetchedAt(new Date().toISOString());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const size = formatSize(attachment.sizeBytes);

  return (
    <div
      className="selectable font-[family-name:var(--font-ui)] text-[12px]"
      style={{ color: "var(--text-muted)" }}
    >
      <div className="flex items-baseline gap-2">
        <span className="translate-y-px" style={{ color: "var(--text-faint)" }}>
          <Paperclip />
        </span>
        {/* Opened outside this window rather than linked into it. An `href`
            with `target="_blank"` leaves what happens to the webview, and a
            page loaded over the client has no way back.

            The filename is what is on screen, so it is what is announced; the
            whole URL stays in the tooltip. */}
        <span
          ref={anchor}
          className="relative flex min-w-0"
          onPointerEnter={() => setPeeking(true)}
          onPointerLeave={() => setPeeking(false)}
          onFocus={() => setPeeking(true)}
          onBlur={() => setPeeking(false)}
        >
          <button
            type="button"
            onClick={() => {
              setError(null);
              void openExternal(attachment.url).catch((reason: unknown) => {
                setError(`could not open — ${String(reason)}`);
              });
            }}
            aria-label={leavingLabel(filenameOf(attachment))}
            title={attachment.url}
            className="cursor-pointer truncate font-[family-name:var(--font-mono)] underline decoration-from-font underline-offset-2 hover:decoration-2"
            style={{ color: "var(--text-secondary)" }}
          >
            {filenameOf(attachment)}
            <LeavesTheClient />
          </button>
          {preview && peeking && (
            <span
              role="tooltip"
              className={clsx(
                "pointer-events-none absolute left-0 z-50 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]",
                fit.side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
              )}
            >
              <img
                src={preview.dataUri}
                alt={filenameOf(attachment)}
                width={preview.width}
                height={preview.height}
                style={{ maxHeight: fit.maxHeight }}
                className="block w-auto max-w-[min(420px,60vw)] rounded-[var(--radius-sm)]"
              />
            </span>
          )}
        </span>
        {size && <span className="shrink-0 font-[family-name:var(--font-mono)]">{size}</span>}
        {fetchedAt && (
          <span className="shrink-0" style={{ color: "var(--text-faint)" }}>
            · fetched {formatClock(fetchedAt)}
          </span>
        )}
        {!preview && attachment.mime !== null && (
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="shrink-0"
            style={{ color: "var(--accent)" }}
          >
            {loading ? "fetching" : "fetch"}
          </button>
        )}
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </div>
    </div>
  );
}
