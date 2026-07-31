import { useCallback, useState } from "react";
import { ipc } from "@/lib/ipc";
import {
  emptyDraft,
  presetDraft,
  PUBLIC_NETWORKS,
  toConfig,
  type Draft,
  type PublicNetwork,
} from "./config";
import { Connecting } from "./Connecting";
import { LinkButton } from "./fields";
import { PublicNetworkForm } from "./PublicNetworkForm";
import { ServerForm } from "./ServerForm";

type FormStep = "public" | "server" | "advanced";
type Step = FormStep | "choose" | "connect";

const FIRST = PUBLIC_NETWORKS[0] as PublicNetwork;

/** Opens the flow on a form instead of the chooser, for the entry points that
 * already know which network they mean (#45). Back then leaves the flow, since
 * there is no chooser behind it to go back to. */
export interface OnboardingStart {
  step: "server" | "advanced";
  draft: Draft;
}

export function Onboarding({
  onDone,
  start,
}: {
  onDone: () => void;
  start?: OnboardingStart;
}) {
  const [step, setStep] = useState<Step>(start?.step ?? "choose");
  /** Where "Edit settings" goes back to from the connect step. */
  const [form, setForm] = useState<FormStep>(start?.step ?? "public");
  const [preset, setPreset] = useState<PublicNetwork>(FIRST);
  const [draft, setDraft] = useState<Draft>(
    () => start?.draft ?? presetDraft(FIRST, emptyDraft()),
  );
  const [networkId, setNetworkId] = useState<string | null>(start?.draft.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(
    (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch })),
    [],
  );

  function openForm(next: FormStep) {
    setForm(next);
    setStep(next);
    setError(null);
  }

  function choosePublic() {
    setDraft((current) => presetDraft(preset, current));
    openForm("public");
  }

  function chooseManual(next: "server" | "advanced") {
    setDraft((current) => ({ ...current, name: "", host: "" }));
    openForm(next);
  }

  function choosePreset(network: PublicNetwork) {
    setPreset(network);
    setDraft((current) => presetDraft(network, current));
  }

  async function attempt(id: string) {
    setError(null);
    try {
      await ipc.connectNetwork(id);
    } catch (reason) {
      setError(reasonOr(reason, "The connection could not be started."));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);

    let id: string;
    try {
      id = await ipc.saveNetwork(toConfig(draft));
    } catch (reason) {
      setError(reasonOr(reason, "The network could not be saved."));
      setBusy(false);
      return;
    }

    // Keeping the id makes a second save an update rather than a duplicate, and
    // the typed password can go: the keyring holds it now and never gives it back.
    setNetworkId(id);
    setDraft((current) => ({ ...current, id, password: null }));
    setStep("connect");
    await attempt(id);
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await ipc.removeNetwork(id);
      onDone();
    } catch (reason) {
      setError(reasonOr(reason, "The network could not be removed."));
      setBusy(false);
    }
  }

  const submit = () => void save();
  const back = start ? onDone : () => setStep("choose");

  return (
    <div className="flex h-full min-h-0 items-center-safe justify-center overflow-y-auto bg-[var(--surface-base)] px-6 py-12">
      <div className="w-full max-w-[480px]">
        {step === "choose" && (
          <Chooser
            onPublic={choosePublic}
            onServer={() => chooseManual("server")}
            onAdvanced={() => chooseManual("advanced")}
            onSkip={onDone}
          />
        )}

        {step === "public" && (
          <PublicNetworkForm
            draft={draft}
            preset={preset}
            onChange={change}
            onPreset={choosePreset}
            onSubmit={submit}
            onBack={back}
            onAdvanced={() => openForm("advanced")}
            busy={busy}
            error={error}
          />
        )}

        {(step === "server" || step === "advanced") && (
          <ServerForm
            draft={draft}
            advanced={step === "advanced"}
            onChange={change}
            onSubmit={submit}
            onBack={back}
            onAdvanced={() => openForm("advanced")}
            onRemove={draft.id ? () => void remove(draft.id!) : undefined}
            busy={busy}
            error={error}
          />
        )}

        {step === "connect" && networkId && (
          <Connecting
            network={networkId}
            error={error}
            onRetry={() => void attempt(networkId)}
            onBack={() => setStep(form)}
            onDone={onDone}
          />
        )}
      </div>
    </div>
  );
}

function Chooser({
  onPublic,
  onServer,
  onAdvanced,
  onSkip,
}: {
  onPublic: () => void;
  onServer: () => void;
  onAdvanced: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[17px] font-medium text-[var(--text-primary)]">
          Welcome to ircx
        </h1>
        <p className="text-[var(--text-secondary)]">
          Add a network to start talking.
        </p>
      </header>

      <nav aria-label="Ways to add a network" className="flex flex-col gap-1.5">
        <Choice
          title="Join a public network"
          blurb="Libera.Chat, OFTC, or Rizon. A nickname is all it needs."
          onClick={onPublic}
        />
        <Choice
          title="Connect to an IRC server"
          blurb="Any server, by address. TLS and reconnect are already on."
          onClick={onServer}
        />
        <Choice
          title="Advanced setup"
          blurb="Ports, alternate nicknames, SASL, connect commands — every field."
          onClick={onAdvanced}
        />
      </nav>

      <div>
        <LinkButton onClick={onSkip}>Skip for now</LinkButton>
      </div>
    </div>
  );
}

function Choice({
  title,
  blurb,
  onClick,
}: {
  title: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-2.5 text-left hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
    >
      <span className="text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
      <span className="text-[11px] text-[var(--text-muted)]">{blurb}</span>
    </button>
  );
}

/** Tauri rejects with the handler's user-facing string; anything else is a bug
 * in the bridge and gets a sentence the user can act on instead. */
function reasonOr(reason: unknown, fallback: string): string {
  return typeof reason === "string" && reason.length > 0 ? reason : fallback;
}
