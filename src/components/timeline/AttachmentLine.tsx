import { useState } from "react";
import type { Attachment, AttachmentPreview } from "@/types";
import { ipc } from "@/lib/ipc";
import { formatClock } from "./rows";

const UNITS = ["B", "KB", "MB", "GB"];

export function formatSize(bytes: bigint | null): string | null {
  if (bytes === null) return null;
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

function filenameOf(attachment: Attachment): string {
  if (attachment.filename) return attachment.filename;
  const path = attachment.url.split("?")[0] ?? attachment.url;
  return path.slice(path.lastIndexOf("/") + 1) || attachment.url;
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
 * network until the reader asks for them.
 */
export function AttachmentLine({ attachment }: { attachment: Attachment }) {
  // Held locally rather than pushed into the store: a preview is session-only,
  // and nothing about the message on disk changed when the user asked for it.
  const [preview, setPreview] = useState<AttachmentPreview | null>(attachment.preview);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate font-[family-name:var(--font-mono)]"
          style={{ color: "var(--text-secondary)" }}
        >
          {filenameOf(attachment)}
        </a>
        {size && <span className="shrink-0 font-[family-name:var(--font-mono)]">{size}</span>}
        {fetchedAt && (
          <span className="shrink-0" style={{ color: "var(--text-faint)" }}>
            · fetched {formatClock(fetchedAt)}
          </span>
        )}
        {!preview && (
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

      {preview && (
        <img
          src={preview.dataUri}
          alt={filenameOf(attachment)}
          width={preview.width}
          height={preview.height}
          className="my-1 max-h-[220px] w-auto max-w-full rounded-[var(--radius-sm)]"
        />
      )}
    </div>
  );
}
