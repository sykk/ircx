import { useState } from "react";
import type { Attachment, AttachmentPreview } from "@/types";
import { Icon } from "@/components/common/Icon";
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
 * An attachment is an offer, not a card: one line, and no bytes cross the
 * network until the reader asks for them.
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
          <Icon name="paperclip" size={13} />
        </span>
        {/* Opened outside this window rather than linked into it. An `href`
            with `target="_blank"` leaves what happens to the webview, and a
            page loaded over the client has no way back.

            The filename is what is on screen, so it is what is announced; the
            whole URL stays in the tooltip. */}
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
