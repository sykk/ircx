import { useEffect, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/onboarding/fields";
import { ipc, onFileDrop } from "@/lib/ipc";
import { useActiveTarget } from "@/store/selectors";

/**
 * Dropping a file on the window uploads it to the conversation in focus.
 *
 * The webview's own drag events are not used: Tauri intercepts the drop at the
 * window and hands over real paths, and a path is what the upload needs. An
 * HTML5 drop inside a webview gives a file with no path at all.
 *
 * Every upload is confirmed, and there is no "do not ask again". A file leaving
 * the user's machine for a third party is the one thing in this client that
 * cannot be taken back, the cost of asking is a keystroke, and a box that
 * suppresses the question is the box everybody clicks.
 */
export function DropToUpload() {
  const active = useActiveTarget();
  const [hovering, setHovering] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stop = onFileDrop((event) => {
      if (event.kind === "over") {
        setHovering(true);
        return;
      }
      setHovering(false);
      if (event.kind === "drop" && event.paths.length > 0) {
        setError(null);
        setPending(event.paths);
      }
    });
    return () => void stop.then((off) => off());
  }, []);

  // Read when a drop lands rather than on mount: the confirmation names where
  // the file is going, and the provider can have changed since the app started.
  useEffect(() => {
    if (pending === null) return;
    let live = true;
    void ipc.getUploadProvider().then(
      (provider) => {
        if (!live) return;
        setHost(provider === null ? null : hostOf(provider.endpoint));
      },
      () => {
        if (live) setHost(null);
      },
    );
    return () => {
      live = false;
    };
  }, [pending]);

  if (active === null) return null;

  async function send() {
    if (pending === null || active === null) return;
    setBusy(true);
    setError(null);
    try {
      // One at a time, in the order they were dropped, so the links arrive in
      // the conversation in the order the user sees them listed.
      for (const path of pending) {
        const link = await ipc.uploadFile(path);
        await ipc.submitInput(active.network, active.target, link);
      }
      setPending(null);
    } catch (reason) {
      setError(
        typeof reason === "string" && reason.trim() !== ""
          ? reason
          : "The file could not be uploaded.",
      );
    }
    setBusy(false);
  }

  return (
    <>
      {hovering && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
          <div className="absolute inset-0 bg-[var(--scrim)]" />
          <p
            className="relative rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--accent)] px-8 py-6 text-[14px]"
            style={{ color: "var(--text-primary)" }}
          >
            Drop to upload to {active.target}
          </p>
        </div>
      )}

      {pending !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-[var(--scrim)]" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Upload"
            className="relative flex w-[min(460px,92vw)] flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] p-6 shadow-[var(--shadow-overlay)]"
          >
            <h2 className="text-[15px] font-semibold">
              {pending.length === 1 ? "Upload this file?" : `Upload ${pending.length} files?`}
            </h2>
            <ul className="flex flex-col gap-1 text-[13px]">
              {pending.map((path) => (
                <li key={path} className="truncate font-[family-name:var(--font-mono)]">
                  {nameOf(path)}
                </li>
              ))}
            </ul>
            <p className="text-[12px] text-[var(--text-muted)]">
              {host === null ? (
                <>No upload provider is configured, so there is nowhere to send this.</>
              ) : (
                <>
                  It goes to <strong>{host}</strong>, and the link is sent to{" "}
                  <strong>{active.target}</strong>. Anyone with the link can read it.
                </>
              )}
            </p>

            {error !== null && (
              <p role="alert" className="text-[12px] text-[var(--danger)]">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={busy || host === null} onClick={() => void send()}>
                {busy ? "Uploading…" : "Upload"}
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function nameOf(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** The host the file is going to, which is the part of an endpoint the user
 * needs to recognise. A malformed one is shown whole rather than hidden. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
