import { useState } from "react";
import { formatBytes } from "@/lib/bytes";
import { chooseSavePath, ipc, reasonOr, revealFolder } from "@/lib/ipc";
import type { Transfer, TransferState } from "@/types";

/** The words a state is drawn in, and the token it is drawn in. */
const STATE: Record<TransferState, { label: string; color: string }> = {
  offered: { label: "Waiting", color: "var(--text-muted)" },
  connecting: { label: "Connecting", color: "var(--text-muted)" },
  running: { label: "Transferring", color: "var(--accent)" },
  done: { label: "Finished", color: "var(--success)" },
  declined: { label: "Declined", color: "var(--text-muted)" },
  cancelled: { label: "Cancelled", color: "var(--text-muted)" },
  failed: { label: "Failed", color: "var(--danger)" },
};

/** Whether anything more can happen to it. */
export function isOver(state: TransferState): boolean {
  return state === "done" || state === "declined" || state === "cancelled" || state === "failed";
}

/** The directory a finished file is in, which is what the file manager opens.
 * Both separators, because the path came from whichever machine this is. */
function folderOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at > 0 ? path.slice(0, at) : path;
}

/**
 * How far a transfer has got, in the words that fit the case.
 *
 * A sender that named no size makes a proportion impossible, and the count is
 * drawn on its own rather than against a total that was never given.
 */
export function progressOf(transfer: Transfer): string {
  const at = Number(transfer.at);
  const size = Number(transfer.size);
  if (size === 0) return formatBytes(at);
  return `${formatBytes(at)} of ${formatBytes(size)}`;
}

/**
 * What can be done about one transfer, and how far it has got.
 *
 * Drawn both on the row that announced it and in the panel that lists every
 * one, so the two cannot say different things about the same file — which is
 * the whole reason there is one component rather than a set of buttons in each
 * place.
 */
export function TransferControls({ transfer }: { transfer: Transfer }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = Number(transfer.size);
  const at = Number(transfer.at);
  const state = STATE[transfer.state];
  const incoming = transfer.direction === "incoming";
  const waiting = transfer.state === "offered";

  const run = (what: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    void what()
      .catch((reason: unknown) => setError(reasonOr(reason, fallback)))
      .finally(() => setBusy(false));
  };

  const accept = (path: string | null) =>
    run(
      () => ipc.acceptTransfer(transfer.network, transfer.id, path),
      "The file could not be accepted.",
    );

  const saveAs = () =>
    run(async () => {
      const path = await chooseSavePath(transfer.file, []);
      if (path === null) return;
      await ipc.acceptTransfer(transfer.network, transfer.id, path);
    }, "The file could not be accepted.");

  return (
    <div data-ui="transfer" data-state={transfer.state} className="flex flex-col gap-1 py-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
        <span style={{ color: state.color }}>{state.label}</span>
        <span style={{ color: "var(--text-faint)" }}>{progressOf(transfer)}</span>
        {transfer.state === "running" && size > 0 && (
          <span style={{ color: "var(--text-faint)" }}>
            {Math.floor((at / size) * 100)}%
          </span>
        )}
      </div>

      {transfer.state === "running" && size > 0 && (
        <div
          role="progressbar"
          aria-valuenow={at}
          aria-valuemin={0}
          aria-valuemax={size}
          aria-label={`${transfer.file}, ${progressOf(transfer)}`}
          className="h-1 w-full max-w-[16rem] overflow-hidden rounded-full"
          style={{ background: "var(--surface-raised)" }}
        >
          <div
            className="h-full"
            style={{
              width: `${Math.min(100, (at / size) * 100)}%`,
              background: "var(--accent)",
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {incoming && waiting && (
          <>
            <TransferButton onClick={() => accept(null)} disabled={busy}>
              Accept
            </TransferButton>
            <TransferButton onClick={saveAs} disabled={busy}>
              Save as…
            </TransferButton>
            <TransferButton
              onClick={() =>
                run(
                  () => ipc.declineTransfer(transfer.network, transfer.id),
                  "The offer could not be declined.",
                )
              }
              disabled={busy}
            >
              Decline
            </TransferButton>
          </>
        )}
        {!isOver(transfer.state) && !(incoming && waiting) && (
          <TransferButton
            onClick={() =>
              run(
                () => ipc.cancelTransfer(transfer.network, transfer.id),
                "The transfer could not be stopped.",
              )
            }
            disabled={busy}
          >
            Cancel
          </TransferButton>
        )}
        {transfer.state === "done" && transfer.path !== null && (
          <TransferButton
            onClick={() =>
              run(
                () => revealFolder(folderOf(transfer.path ?? "")),
                "The folder could not be opened.",
              )
            }
            disabled={busy}
          >
            Show in folder
          </TransferButton>
        )}
      </div>

      {transfer.failure !== null && (
        <p className="text-[12px]" style={{ color: "var(--danger)" }}>
          {transfer.failure}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-[12px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function TransferButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="cursor-pointer rounded border px-2 py-0.5 text-[12px] disabled:cursor-default disabled:opacity-50"
      style={{
        borderColor: "var(--border-default)",
        color: "var(--text-primary)",
      }}
    >
      {children}
    </button>
  );
}
