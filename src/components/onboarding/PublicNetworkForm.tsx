import { useState, type FormEvent } from "react";
import clsx from "clsx";
import { PUBLIC_NETWORKS, type Draft, type PublicNetwork } from "./config";
import {
  CheckField,
  LinkButton,
  Note,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "./fields";
import { nicknameProblem } from "./nickname";
import { useAnnounce } from "@/hooks/useAnnounce";

interface Props {
  draft: Draft;
  preset: PublicNetwork;
  onChange: (patch: Partial<Draft>) => void;
  onPreset: (network: PublicNetwork) => void;
  onSubmit: () => void;
  onBack: () => void;
  onAdvanced: () => void;
  busy: boolean;
  error: string | null;
}

export function PublicNetworkForm({
  draft,
  preset,
  onChange,
  onPreset,
  onSubmit,
  onBack,
  onAdvanced,
  busy,
  error,
}: Props) {
  useAnnounce(error);
  const [submitted, setSubmitted] = useState(false);
  const nickError = nicknameProblem(draft.nick.trim(), preset.nickLimit);
  const showNickError = nickError && (submitted || draft.nick.length > 0);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nickError) return;
    onSubmit();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[17px] font-medium text-[var(--text-primary)]">
          Join a public network
        </h1>
        <p className="text-[var(--text-secondary)]">
          Pick a network and a nickname. Everything else has a sensible default.
        </p>
      </header>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="sr-only">Network</legend>
        {PUBLIC_NETWORKS.map((network) => {
          const selected = network.host === preset.host;
          return (
            <label
              key={network.host}
              className={clsx(
                "flex gap-2.5 rounded-[var(--radius-md)] border px-3 py-2",
                "focus-within:border-[var(--accent)]",
                selected
                  ? "border-[var(--accent)] bg-[var(--surface-raised)]"
                  : "border-[var(--border-default)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <input
                type="radio"
                name="public-network"
                checked={selected}
                onChange={() => onPreset(network)}
                className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {network.name}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--text-faint)]">
                    {network.host}
                  </span>
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">{network.blurb}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <TextField
        autoFocus
        label="Nickname"
        value={draft.nick}
        onChange={(nick) => onChange({ nick })}
        placeholder="sable"
        error={showNickError ? nickError : null}
        hint={`Up to ${preset.nickLimit} characters on ${preset.name}.`}
      />

      <CheckField
        label={`I have an account on ${preset.name}`}
        hint="Registered nicknames are authenticated over SASL before anyone else sees you connect."
        checked={draft.mechanism !== "none"}
        onChange={(checked) => onChange({ mechanism: checked ? "PLAIN" : "none" })}
      />

      {draft.mechanism !== "none" && (
        <div className="flex flex-col gap-3 border-l border-[var(--border-default)] pl-3">
          <TextField
            optional
            label="Account name"
            value={draft.account}
            onChange={(account) => onChange({ account })}
            placeholder={draft.nick.trim() || "sable"}
            hint="Defaults to your nickname."
          />
          <TextField
            label="Password"
            type="password"
            value={draft.password ?? ""}
            onChange={(password) => onChange({ password })}
            hint="Stored in your operating system's keyring, never in the database."
          />
        </div>
      )}

      <TextField
        optional
        label="Channels to join"
        value={draft.autojoin}
        onChange={(autojoin) => onChange({ autojoin })}
        placeholder="#linux #rust"
        hint="Separate them with spaces. The # is added if you leave it out."
      />

      <Note>
        ircx connects over TLS on port {draft.port}, negotiates IRCv3 capabilities, and
        reconnects on its own. All of it is editable in advanced setup.
      </Note>

      {error && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton disabled={busy}>{busy ? "Connecting…" : "Connect"}</PrimaryButton>
        <span className="flex-1" />
        <LinkButton onClick={onAdvanced}>Advanced setup</LinkButton>
      </div>
    </form>
  );
}
