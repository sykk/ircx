import { useEffect, useRef, useState } from "react";
import { useTransfers } from "@/store/selectors";
import { useDisplayedNetwork } from "@/components/shell/connection";
import type { Transfer } from "@/types";
import { isOver, TransferControls } from "./TransferControls";

/**
 * Files moving, listed in one place.
 *
 * The conversation is where a transfer is answered, and this is where one that
 * has scrolled out of it is found again — a download running for ten minutes
 * outlives the reader's place in the channel it was offered in, and a client
 * that only draws it on that row is one where a stalled transfer becomes
 * invisible rather than finished.
 *
 * It lives in the status bar because that is where this client already reports
 * what is happening rather than what is being said, and it is drawn only when
 * there is something to draw: a control for a thing nobody is doing is chrome
 * the mockup would not have drawn.
 */
export function TransfersStatus() {
  const network = useDisplayedNetwork();
  const transfers = useTransfers(network?.id ?? null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  const moving = transfers.filter((transfer) => !isOver(transfer.state));

  // The two ways out of a popover. Anchored on the whole control rather than on
  // the panel, so that clicking the button that opened it closes it — a check
  // against the panel alone closes on the press and reopens on the click.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const away = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && anchor.current?.contains(target) === false) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", away);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", away);
    };
  }, [open]);

  // A control for nothing is chrome. Shut during render rather than in an
  // effect, so a panel whose last transfer was forgotten is not left open to
  // reappear with the next one — the same adjustment the status bar makes when
  // the figure it is counting down from changes.
  if (transfers.length === 0) {
    if (open) setOpen(false);
    return null;
  }

  return (
    <div ref={anchor} className="relative flex shrink-0 items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Transfers, ${moving.length} in progress`}
        onClick={() => setOpen((shown) => !shown)}
        className="cursor-pointer rounded-[var(--radius-sm)] px-1 tabular-nums hover:text-[var(--text-secondary)]"
        style={{ color: moving.length > 0 ? "var(--accent)" : "var(--text-muted)" }}
      >
        {moving.length > 0 ? `${moving.length} transferring` : "Transfers"}
      </button>
      {open && <TransferList transfers={transfers} />}
    </div>
  );
}

/**
 * A popover rather than a dialog: nothing behind it is being changed, so the
 * window stays workable while it is open and the keyboard is not trapped.
 */
function TransferList({ transfers }: { transfers: Transfer[] }) {
  return (
    <div
      role="dialog"
      aria-label="Transfers"
      data-ui="transfers-panel"
      className="absolute right-0 bottom-full mb-1 flex max-h-[60vh] w-[22rem] flex-col gap-2 overflow-y-auto rounded-[var(--radius-md)] border p-3 text-[12px] shadow-[var(--shadow-overlay)]"
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-default)",
        color: "var(--text-primary)",
      }}
    >
      {transfers.map((transfer) => (
        <div
          key={transfer.id}
          className="flex flex-col gap-0.5 border-b pb-2 last:border-b-0 last:pb-0"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <span className="truncate font-medium">{transfer.file}</span>
          <span style={{ color: "var(--text-faint)" }}>
            {transfer.direction === "incoming" ? "from" : "to"} {transfer.peer}
          </span>
          <TransferControls transfer={transfer} />
        </div>
      ))}
    </div>
  );
}
