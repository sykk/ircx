import { useState } from "react";
import type { Attachment, AttachmentPreview } from "@/types";
import { ipc } from "@/lib/ipc";

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

/** Lower case on purpose: a screen reader spells `PNG` out letter by letter. */
function shortMime(mime: string | null): string | null {
  if (!mime) return null;
  return mime.split("/")[1] ?? mime;
}

function filenameOf(attachment: Attachment): string {
  if (attachment.filename) return attachment.filename;
  const path = attachment.url.split("?")[0] ?? attachment.url;
  return path.slice(path.lastIndexOf("/") + 1) || attachment.url;
}

export function AttachmentCard({ attachment }: { attachment: Attachment }) {
  // Held locally rather than pushed into the store: a preview is session-only,
  // and nothing about the message on disk changed when the user asked for it.
  const [preview, setPreview] = useState<AttachmentPreview | null>(attachment.preview);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await ipc.loadPreview(attachment.url);
      setPreview(loaded.preview);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const meta = [formatSize(attachment.sizeBytes), shortMime(attachment.mime)].filter(Boolean);

  return (
    <div
      className="my-1 inline-flex max-w-[420px] items-stretch gap-3 rounded-[var(--radius-md)] border p-2"
      style={{ background: "var(--surface-raised)", borderColor: "var(--border-default)" }}
    >
      <div
        className="flex h-[64px] w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)]"
        style={{ background: "var(--surface-base)" }}
      >
        {preview ? (
          <img
            src={preview.dataUri}
            alt={filenameOf(attachment)}
            width={preview.width}
            height={preview.height}
            className="h-full w-full object-cover"
          />
        ) : (
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="h-full w-full text-[11px]"
            style={{ color: "var(--accent)" }}
          >
            {loading ? "Loading" : "Load preview"}
          </button>
        )}
      </div>

      <div className="selectable flex min-w-0 flex-col justify-center gap-0.5">
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer noopener"
          className="truncate text-[12px]"
          style={{ color: "var(--text-primary)" }}
        >
          {filenameOf(attachment)}
        </a>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {meta.join(" · ")}
        </span>
        {error && (
          <span className="text-[11px]" style={{ color: "var(--danger)" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
