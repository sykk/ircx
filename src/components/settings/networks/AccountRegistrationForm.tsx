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

const REGISTRATION = "draft/account-registration";

/**
 * Whether the network said it takes registrations. Where it did, the whole
 * exchange is the protocol's and the server answers for its own rules.
 */
export function offersRegistration(network: Network): boolean {
  return network.capsEnabled.includes(REGISTRATION);
}

function isLibera(network: Network): boolean {
  const host = network.host.toLowerCase().replace(/\.$/, "");
  return host === "libera.chat" || host.endsWith(".libera.chat");
}

/**
 * Libera is still named here, and only here. It runs no such capability and
 * answers a message to NickServ instead, which is a rule about one network
 * rather than anything a server states — so it is the client that has to hold
 * it. Every other network reaches this by saying so itself.
 */
export function canRegisterAccount(network: Network): boolean {
  return (
    (offersRegistration(network) || isLibera(network)) &&
    network.tls &&
    network.status.state === "connected" &&
    network.currentNick !== null &&
    network.sasl.state !== "authenticated"
  );
}

export function AccountRegistrationForm({
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
  const negotiated = offersRegistration(network);
  useAnnounce(error ?? (sent ? "Registration sent." : null));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    reportBusy(true);
    setError(null);
    try {
      await ipc.registerAccount(network.id, account, password, email);
      setPassword("");
      setEmail("");
      setSent(true);
    } catch (reason) {
      setError(reasonOr(reason, `The ${network.name} account could not be registered.`));
    } finally {
      setBusy(false);
      reportBusy(false);
    }
  }

  return (
    <SettingsPage
      title={`Register an account on ${network.name}`}
      blurb="Register the nick on this connection and save it for SASL login. The password and email bypass conversations, archives, notifications, plugins, and the readable raw log."
      onDone={onDone}
    >
      {sent ? (
        <div className="flex max-w-lg flex-col gap-4">
          <p role="status" className="text-[13px] text-[var(--text-primary)]">
            Registration was sent and the SASL PLAIN login was saved.
          </p>
          <p className="text-[12px] leading-5 text-[var(--text-muted)]">
            {negotiated
              ? "If the account needs verifying, the server said so in this network's tab. Run /verify with the code it sends you."
              : `Check your email and run the NickServ verification command it contains within about 24 hours.`}{" "}
            After verification, reconnect from Networks to sign in with the saved account.
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
            hint={`Most networks register the nick you are connected as (${network.currentNick}).`}
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
            hint={
              negotiated
                ? `Where ${network.name} sends a verification code. Leave it empty if it does not ask for one.`
                : `${network.name} sends the verification command and account recovery mail here.`
            }
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
