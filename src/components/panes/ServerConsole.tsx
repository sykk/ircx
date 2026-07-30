import { useState, type FormEvent } from "react";
import { ConsoleHeader } from "@/components/header/ConsoleHeader";
import { Timeline } from "@/components/timeline/Timeline";
import { ipc } from "@/lib/ipc";
import { useNetwork } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { SERVER_TARGET } from "@/types";
import { RawLog } from "./RawLog";

/**
 * The pane on `SERVER_TARGET`: what the server says to you rather than to a
 * channel — the connection line, the MOTD, notices, your own umode — and the
 * raw transcript underneath it.
 */
export function ServerConsole({ view, network }: { view: ViewId | null; network: string }) {
  const [raw, setRaw] = useState(false);
  const details = useNetwork(network);
  if (!details) return null;

  return (
    <>
      <ConsoleHeader
        view={view}
        network={details}
        raw={raw}
        onToggleRaw={() => setRaw((showing) => !showing)}
      />
      <div className="min-h-0 flex-1">
        {raw ? <RawLog network={network} /> : <Timeline view={view} />}
      </div>
      <ConsoleComposer network={network} name={details.name} />
    </>
  );
}

/**
 * Commands, not conversation. There is no recipient here, so nothing reports
 * typing and nothing saves a draft; plain text is refused by core with the
 * reason, which this shows.
 */
function ConsoleComposer({ network, name }: { network: string; name: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const input = value.trim();
    if (input === "") return;
    setValue("");
    setError(null);

    // Anything a command has to say arrives as messages on this target, so the
    // timeline above draws it; only the refusal has nowhere else to go.
    const outcome = await ipc.submitInput(network, SERVER_TARGET, input);
    if (outcome.kind !== "rejected") return;
    setError(outcome.value);
    // Only into an empty box: the next command may already be half typed.
    setValue((current) => (current === "" ? input : current));
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
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setError(null);
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
