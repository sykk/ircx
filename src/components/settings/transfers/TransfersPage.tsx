import { useCallback, useEffect, useState } from "react";
import {
  CheckField,
  Group,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { chooseFolder, ipc, reasonOr } from "@/lib/ipc";
import { useAnnounce } from "@/hooks/useAnnounce";
import type { TransferSettings } from "@/types";

/** What the form holds. The port range is two fields rather than one pair,
 * because a half-typed range has to survive being half-typed. */
interface Draft {
  directory: string;
  firstPort: string;
  lastPort: string;
  address: string;
  passive: boolean;
}

function toDraft(settings: TransferSettings): Draft {
  return {
    directory: settings.directory,
    firstPort: settings.ports === null ? "" : String(settings.ports[0]),
    lastPort: settings.ports === null ? "" : String(settings.ports[1]),
    address: settings.address ?? "",
    passive: settings.passive,
  };
}

/** `null` where the range is refused, which the caller reports rather than
 * saves. Both fields empty is not a refusal: it is the operating system
 * choosing, which is the default. */
function portsOf(draft: Draft): { ports: [number, number] | null } | null {
  const first = draft.firstPort.trim();
  const last = draft.lastPort.trim();
  if (first === "" && last === "") return { ports: null };
  const from = Number(first);
  const to = Number(last);
  const whole = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;
  if (!whole(from) || !whole(to)) return null;
  return { ports: [from, to] };
}

/**
 * Where a file sent directly lands, and what this client can tell the other
 * side about reaching it.
 *
 * The address and the ports are one subject in two fields: DCC names an address
 * and a port in a message, and a client behind a router has neither to give.
 * The page says so rather than leaving somebody to find out when a transfer
 * times out.
 */
export function TransfersPage({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusyHere] = useState(false);
  /* The window's Escape is caught above every page, so a page cannot guard its
     own way out — it says it is busy instead. */
  const report = useReportBusy();
  const setBusy = useCallback(
    (running: boolean) => {
      setBusyHere(running);
      report(running);
    },
    [report],
  );
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  useAnnounce(said ?? error);

  useEffect(() => {
    let live = true;
    void ipc.transferSettings().then(
      (settings) => {
        if (live) setDraft(toDraft(settings));
      },
      (reason: unknown) => {
        if (live) setError(reasonOr(reason, "The transfer settings could not be read."));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    if (draft === null) return;
    setSaid(null);
    const range = portsOf(draft);
    if (range === null) {
      setError("A port range is two port numbers, or both fields empty.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await ipc.setTransferSettings({
        directory: draft.directory.trim(),
        ports: range.ports,
        address: draft.address.trim() === "" ? null : draft.address.trim(),
        passive: draft.passive,
      });
      setSaid("Saved.");
    } catch (reason) {
      setError(reasonOr(reason, "The transfer settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder() {
    if (draft === null) return;
    const picked = await chooseFolder("Where received files land");
    if (picked !== null) setDraft({ ...draft, directory: picked });
  }

  return (
    <SettingsPage
      title="Transfers"
      blurb="Files sent straight between two clients, without a host in the middle. Every offer is accepted by hand; nothing arrives on its own."
      onDone={() => {
        if (!busy) onDone();
      }}
    >
      {draft === null ? (
        <p
          role={error === null ? undefined : "alert"}
          className="text-[12px]"
          style={{ color: error === null ? "var(--text-muted)" : "var(--danger)" }}
        >
          {error ?? "Reading the settings…"}
        </p>
      ) : (
        <div className="flex max-w-[560px] flex-col gap-4">
          <Group title="Where files land">
            <TextField
              label="Folder"
              value={draft.directory}
              onChange={(directory) => setDraft({ ...draft, directory })}
              hint="A file whose name is already taken here arrives numbered. Nothing is ever overwritten."
            />
            <SecondaryButton onClick={() => void pickFolder()} disabled={busy}>
              Choose…
            </SecondaryButton>
          </Group>

          <Group title="Being reachable">
            <p className="text-[11px] text-[var(--text-muted)]">
              An offer names an address and a port for the other client to connect to. On a
              machine behind a router, neither is one they can reach — which is what the two
              settings below are for.
            </p>
            <TextField
              label="Address to offer"
              value={draft.address}
              onChange={(address) => setDraft({ ...draft, address })}
              placeholder="203.0.113.7"
              optional
              hint="Left empty, ircx offers the address this connection goes out from."
            />
            <TextField
              label="First port"
              value={draft.firstPort}
              onChange={(firstPort) => setDraft({ ...draft, firstPort })}
              inputMode="numeric"
              optional
              placeholder="40000"
              hint="The range ircx opens a port from. Left empty, the operating system chooses — which works only where this machine is already reachable."
            />
            <TextField
              label="Last port"
              value={draft.lastPort}
              onChange={(lastPort) => setDraft({ ...draft, lastPort })}
              inputMode="numeric"
              optional
              placeholder="40010"
            />
            <CheckField
              label="Ask the other side to open the port"
              checked={draft.passive}
              onChange={(passive) => setDraft({ ...draft, passive })}
              hint="What to do when this machine cannot be reached. It fails where they cannot be reached either, and then one of you has to forward a port."
            />
          </Group>

          <div className="flex items-center gap-3">
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy}>
              Save
            </PrimaryButton>
            {said !== null && (
              <span className="text-[12px] text-[var(--text-muted)]">{said}</span>
            )}
            {error !== null && (
              <span role="alert" className="text-[12px] text-[var(--danger)]">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
