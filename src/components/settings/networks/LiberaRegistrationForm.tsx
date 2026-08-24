import { useState, type FormEvent } from "react";
import {
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ipc, reasonOr } from "@/lib/ipc";
import type { Network } from "@/types";

export function canRegisterLibera(network: Network): boolean {
  const host = network.host.toLowerCase().replace(/\.$/, "");
  return (
    (host === "libera.chat" || host.endsWith(".libera.chat")) &&
    network.tls &&
    network.status.state === "connected" &&
    network.currentNick !== null &&
    network.sasl.state !== "authenticated"
  );
}

export function LiberaRegistrationForm({
  network,
  onBack,
  onDone,
}: {
  network: Network;
  onBack: () => void;
  onDone: () => void;
}) {
  const reportBusy = useReportBusy();
  const [account, setAccount] = useState(network.currentNick ?? "");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  useAnnounce(error ?? (sent ? "Registration sent. Check your email to verify the account." : null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    reportBusy(true);
    setError(null);
    try {
      await ipc.registerLiberaAccount(network.id, account, password, email);
      setPassword("");
      setEmail("");
      setSent(true);
    } catch (reason) {
      setError(reasonOr(reason, "The Libera.Chat account could not be registered."));
    } finally {
      setBusy(false);
      reportBusy(false);
    }
  }

  return (
    <SettingsPage
      title="Register a Libera.Chat account"
      blurb="Register the nick on this connection and save it for SASL login. The password and email bypass conversations, archives, notifications, plugins, and the readable raw log."
      onDone={onDone}
    >
      {sent ? (
        <div className="flex max-w-lg flex-col gap-4">
          <p role="status" className="text-[13px] text-[var(--text-primary)]">
            Registration was sent and the SASL PLAIN login was saved.
          </p>
          <p className="text-[12px] leading-5 text-[var(--text-muted)]">
            Check your email and run the NickServ verification command it contains within about
            24 hours. After verification, reconnect from Networks to sign in with the saved
            account.
          </p>
          <div className="flex">
            <SecondaryButton onClick={onBack}>Back to networks</SecondaryButton>
          </div>
        </div>
      ) : (
        <form className="flex max-w-lg flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <TextField
            label="Account / nick"
            value={account}
            onChange={setAccount}
            hint={`Libera.Chat registers the nick currently connected as ${network.currentNick}.`}
            autoFocus
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            hint="Use a unique password without spaces. It is saved in your system keyring."
          />
          <TextField
            label="Email address"
            value={email}
            onChange={setEmail}
            hint="Libera.Chat sends the verification command and account recovery mail here."
          />

          {error !== null && (
            <p role="alert" className="text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <PrimaryButton disabled={busy}>{busy ? "Registering…" : "Register account"}</PrimaryButton>
            <SecondaryButton disabled={busy} onClick={onBack}>
              Back
            </SecondaryButton>
          </div>
        </form>
      )}
    </SettingsPage>
  );
}
