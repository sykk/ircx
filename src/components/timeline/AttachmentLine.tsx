import { useState } from "react";
import type { Attachment, AttachmentPreview } from "@/types";
import { Icon } from "@/components/common/Icon";
import { LeavesTheClient, leavingLabel } from "@/components/common/LeavesTheClient";
import { ipc, openExternal } from "@/lib/ipc";
import { formatBytes } from "@/lib/bytes";
import { useAppStore } from "@/store";
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
 * An image stays a compact offer until the reader asks for its bytes. A null
 * MIME type means the previewer cannot show it, so ordinary links keep the
 * existing one-line treatment.
 */
export function AttachmentLine({ attachment }: { attachment: Attachment }) {
  // Held locally rather than pushed into the store: a preview is session-only,
  // and nothing about the message on disk changed when the user asked for it.
  const [preview, setPreview] = useState<AttachmentPreview | null>(attachment.preview);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const clockFormat = useAppStore((s) => s.presentation.clock);
  const fetchedClock = fetchedAt === null ? null : formatClock(fetchedAt, clockFormat);
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

  const filename = filenameOf(attachment);
  const size = formatSize(attachment.sizeBytes);
  const details = [
    preview ? `${preview.width} × ${preview.height}` : null,
    size,
    fetchedClock ? `fetched ${fetchedClock}` : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join(" · ");
  const open = () => {
    setError(null);
    void openExternal(attachment.url).catch((reason: unknown) => {
      setError(`could not open — ${String(reason)}`);
    });
  };

  return (
    <div
      className="selectable font-[family-name:var(--font-ui)] text-[12px]"
      style={{ color: "var(--text-muted)" }}
    >
      {attachment.mime === null ? (
        <div className="flex items-baseline gap-2">
          <span className="translate-y-px" style={{ color: "var(--text-faint)" }}>
            <Icon name="paperclip" size={13} />
          </span>
          <button
            type="button"
            onClick={open}
            aria-label={leavingLabel(filename)}
            title={attachment.url}
            className="cursor-pointer truncate font-[family-name:var(--font-mono)] underline decoration-from-font underline-offset-2 hover:decoration-2"
            style={{ color: "var(--text-secondary)" }}
          >
            {filename}
            <LeavesTheClient />
          </button>
          {size && <span className="shrink-0 font-[family-name:var(--font-mono)]">{size}</span>}
        </div>
      ) : preview ? (
        <figure
          data-ui="attachment-preview"
          className="mt-1.5 w-fit max-w-full overflow-hidden rounded-[var(--radius-md)] border"
          style={{ background: "var(--surface-raised)", borderColor: "var(--border-default)" }}
        >
          <div
            className="grid max-h-[220px] max-w-[360px] place-items-center overflow-hidden"
            style={{ background: "var(--surface-base)" }}
          >
            <img
              src={preview.dataUri}
              alt={filename}
              width={preview.width}
              height={preview.height}
              className="block h-auto max-h-[220px] w-auto max-w-full"
            />
          </div>
          <button
            type="button"
            onClick={open}
            aria-label={leavingLabel(filename)}
            title={attachment.url}
            className="flex min-w-[260px] max-w-full cursor-pointer items-center gap-2 border-t px-2.5 py-2 text-left hover:bg-[var(--surface-hover)]"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <span className="shrink-0" style={{ color: "var(--text-faint)" }}>
              <Icon name="paperclip" size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate font-[family-name:var(--font-mono)] text-[12px]"
                style={{ color: "var(--text-primary)" }}
              >
                {filename}
              </span>
              <span
                className="block truncate font-[family-name:var(--font-mono)] text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                {details}
              </span>
            </span>
            <LeavesTheClient />
          </button>
        </figure>
      ) : (
        <div
          data-ui="attachment-offer"
          aria-busy={loading}
          className="mt-1.5 flex min-h-11 w-[360px] max-w-full items-center gap-2 rounded-[var(--radius-md)] border px-2.5 py-1.5"
          style={{ background: "var(--surface-raised)", borderColor: "var(--border-default)" }}
        >
          <span className="shrink-0" style={{ color: "var(--text-faint)" }}>
            <Icon name="paperclip" size={14} />
          </span>
          <button
            type="button"
            onClick={open}
            aria-label={leavingLabel(filename)}
            title={attachment.url}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            <span
              className="block truncate font-[family-name:var(--font-mono)] text-[12px]"
              style={{ color: "var(--text-primary)" }}
            >
              {filename}
              <LeavesTheClient />
            </span>
            {size && (
              <span
                className="block font-[family-name:var(--font-mono)] text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                {size}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label={`Preview ${filename}`}
            className="shrink-0 cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-[var(--disabled-opacity)]"
            style={{ color: "var(--accent)" }}
          >
            {loading ? "Loading…" : "Preview"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
