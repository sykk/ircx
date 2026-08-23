import { useState, type FormEvent } from "react";
import { useAnnounce } from "@/hooks/useAnnounce";
import {
  bouncerAccount,
  draftProblems,
  PLAIN_PORT,
  TLS_PORT,
  type BouncerKind,
  type Draft,
} from "./config";
import {
  CheckField,
  LinkButton,
  Note,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "./fields";

export interface BouncerDetails {
  kind: BouncerKind;
  username: string;
  network: string;
  device: string;
}

interface Props {
  draft: Draft;
  details: BouncerDetails;
  onChange: (patch: Partial<Draft>) => void;
  onDetails: (details: BouncerDetails) => void;
  onSubmit: () => void;
  onBack: () => void;
  onAdvanced: () => void;
  busy: boolean;
  error: string | null;
}

export function BouncerForm({
  draft,
  details,
  onChange,
  onDetails,
  onSubmit,
  onBack,
  onAdvanced,
  busy,
  error,
}: Props) {
  useAnnounce(error);
  const [submitted, setSubmitted] = useState(false);
  const problems = draftProblems(draft);
  const usernameProblem = details.username.trim() === "" ? "Enter your bouncer username." : null;
  const networkProblem = details.network.trim() === "" ? "Enter the network saved in your bouncer." : null;
  const show = (problem: string | null, value: string) =>
    submitted || value.length > 0 ? problem : null;

  function changeDetails(patch: Partial<BouncerDetails>) {
    const next = { ...details, ...patch };
    onDetails(next);
    onChange({
      name: next.network,
      account: bouncerAccount(next.kind, next.username, next.network, next.device),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (problems.host || problems.port || problems.nick || usernameProblem || networkProblem) return;
    onSubmit();
  }

  const name = details.kind === "soju" ? "Soju" : "ZNC";

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[17px] font-medium text-[var(--text-primary)]">
          Connect through {name}
        </h1>
        <p className="text-[var(--text-secondary)]">
          ircx will connect to the bouncer and open one network it keeps online.
        </p>
      </header>

      <TextField
        autoFocus
        label="Bouncer address"
        value={draft.host}
        onChange={(host) => onChange({ host })}
        placeholder="irc.example.org"
        error={show(problems.host ?? null, draft.host)}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
        <TextField
          label="Port"
          inputMode="numeric"
          value={draft.port}
          onChange={(port) => onChange({ port })}
          error={show(problems.port ?? null, draft.port)}
        />
        <div className="pb-1.5">
          <CheckField
            label="Connect over TLS"
            checked={draft.tls}
            onChange={(tls) => onChange({ tls, port: String(tls ? TLS_PORT : PLAIN_PORT) })}
          />
        </div>
      </div>

      <TextField
        label="Nickname"
        value={draft.nick}
        onChange={(nick) => onChange({ nick })}
        placeholder="sable"
        error={show(problems.nick ?? null, draft.nick)}
        hint="The nickname your upstream IRC network uses."
      />

      <TextField
        label="Bouncer username"
        value={details.username}
        onChange={(username) => changeDetails({ username })}
        placeholder="sable"
        error={show(usernameProblem, details.username)}
      />

      <TextField
        label="Network"
        value={details.network}
        onChange={(network) => changeDetails({ network })}
        placeholder={details.kind === "soju" ? "irc.libera.chat" : "libera"}
        error={show(networkProblem, details.network)}
        hint={
          details.kind === "soju"
            ? "The network name saved in Soju, or an IRC server address to add."
            : "The network name shown in ZNC's web interface."
        }
      />

      <TextField
        optional
        label="Device name"
        value={details.device}
        onChange={(device) => changeDetails({ device })}
        placeholder="laptop"
        hint="Distinguishes this copy of ircx when more than one client uses the bouncer."
      />

      <TextField
        label="Bouncer password"
        type="password"
        value={draft.password ?? ""}
        onChange={(password) => onChange({ password })}
        hint="Stored in your operating system's keyring, never in the database."
      />

      <CheckField
        label="Connect to this network when ircx starts"
        checked={draft.autoConnect}
        onChange={(autoConnect) => onChange({ autoConnect })}
      />

      <Note>
        {name} stays connected to the IRC network while ircx is closed and sends the missed
        messages when it reconnects.
      </Note>

      {error && <p role="alert" className="text-[12px] text-[var(--danger)]">{error}</p>}

      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton disabled={busy}>{busy ? "Connecting…" : "Connect"}</PrimaryButton>
        <span className="flex-1" />
        <LinkButton onClick={onAdvanced}>Show every setting</LinkButton>
      </div>
    </form>
  );
}
