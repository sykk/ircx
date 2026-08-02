import type { FormEvent } from "react";
import { useRecall } from "@/components/composer/recall";
import { ConsoleHeader } from "@/components/header/ConsoleHeader";
import { Timeline } from "@/components/timeline/Timeline";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { useNetwork, useView } from "@/store/selectors";
import type { ConsoleInput, ViewId } from "@/store/types";
import { SERVER_TARGET } from "@/types";
import { RawLog } from "./RawLog";

/** A command box nothing has been typed into. One shared object, so the
 * selector falling back to it returns the same reference every render. */
const EMPTY: ConsoleInput = { text: "", error: null };

/**
 * The pane on `SERVER_TARGET`: what the server says to you rather than to a
 * channel — the connection line, the MOTD, notices, your own umode — and the
 * raw transcript underneath it.
 */
export function ServerConsole({ view, network }: { view: ViewId | null; network: string }) {
  const raw = useView(view)?.raw ?? false;
  const setViewRaw = useAppStore((s) => s.setViewRaw);
  const details = useNetwork(network);
  if (!details) return null;

  return (
    <>
      <ConsoleHeader
        view={view}
        network={details}
        raw={raw}
        onToggleRaw={() => {
          if (view) setViewRaw(view, !raw);
        }}
      />
      <div className="min-h-0 flex-1">
        {raw ? <RawLog network={network} /> : <Timeline view={view} />}
      </div>
      <ConsoleComposer view={view} network={network} name={details.name} />
    </>
  );
}

/**
 * Commands, not conversation. There is no recipient here, so nothing reports
 * typing and nothing saves a draft; plain text is refused by core with the
 * reason, which this shows.
 *
 * What is typed lives in the store rather than here, keyed by the pane: a
 * change to the layout's shape rebuilds every pane in the window (#308), and
 * component state does not survive that.
 */
function ConsoleComposer({
  view,
  network,
  name,
}: {
  view: ViewId | null;
  network: string;
  name: string;
}) {
  const { text: value, error } = useAppStore(
    (s) => (view ? s.consoleInput[view] : undefined) ?? EMPTY,
  );
  const setConsoleInput = useAppStore((s) => s.setConsoleInput);
  const recall = useRecall(network, SERVER_TARGET);

  const hold = (next: ConsoleInput) => {
    if (view) setConsoleInput(view, next);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const input = value.trim();
    if (input === "") return;
    hold(EMPTY);
    recall.remember(input);

    // Anything a command has to say arrives as messages on this target, so the
    // timeline above draws it; only the refusal has nowhere else to go.
    const outcome = await ipc.submitInput(network, SERVER_TARGET, input);
    if (outcome.kind !== "rejected") return;
    // The text goes back only into an empty box: the next command may already
    // be half typed. Read from the store rather than closed over, because what
    // is in the box now is not what was there when the command went out.
    const current = view ? (useAppStore.getState().consoleInput[view] ?? EMPTY) : EMPTY;
    hold({ text: current.text === "" ? input : current.text, error: outcome.value });
  };

  return (
    <form onSubmit={send} className="px-3 pb-2">
      {error && (
        <div
          role="alert"
          className="px-1 pb-1 text-[11px]"
          style={{ color: "var(--danger)" }}
        >
          {error}
        </div>
      )}

      <div
        className="flex items-center gap-2 rounded-[var(--radius-lg)] border px-3 py-2"
        style={{ background: "var(--surface-raised)", borderColor: "var(--border-default)" }}
      >
        <span className="font-mono text-[var(--text-faint)]">&gt;</span>
        <input
          value={value}
          onChange={(event) => {
            recall.reset();
            hold({ text: event.target.value, error });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") hold({ text: value, error: null });
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            // One line, so there is no caret movement the arrows could be
            // wanted for here — unlike the composer, they always recall.
            const line =
              event.key === "ArrowUp" ? recall.older(value) : recall.newer();
            if (line === null) return;
            event.preventDefault();
            hold({ text: line, error });
          }}
          spellCheck={false}
          placeholder="/join #channel"
          aria-label={`Command for ${name}`}
          className="selectable min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
          style={{ color: "var(--text-primary)" }}
        />
      </div>

      <div className="px-1 pt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Commands only — /help lists them
      </div>
    </form>
  );
}
