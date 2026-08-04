import { useEffect, useState, type FormEvent } from "react";
import type { SaslMechanism } from "@/types";
import { chooseFile, ipc, reasonOr } from "@/lib/ipc";
import { useAnnounce } from "@/hooks/useAnnounce";
import {
  draftProblems,
  hasStoredPassword,
  needsPassword,
  PLAIN_PORT,
  TLS_PORT,
  type Draft,
} from "./config";
import {
  CheckField,
  Group,
  LinkButton,
  Note,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TextAreaField,
  TextField,
} from "./fields";

interface Props {
  draft: Draft;
  /** Whether the whole `NetworkConfig` is on show or only the four fields a
   * server needs. */
  advanced: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onSubmit: () => void;
  onBack: () => void;
  onAdvanced: () => void;
  /** Given only for a network that is already saved, so adding one has no way
   * to remove something that does not exist yet. */
  onRemove?: (() => void) | undefined;
  busy: boolean;
  error: string | null;
}

/**
 * What can be chosen, which is every mechanism this client can perform.
 *
 * EXTERNAL was taken out in #373 for the right reason — it names the client
 * certificate in its own label and nothing here could present one, so choosing
 * it bought a connection that succeeded and a login that did not. #401 built
 * the certificate, so it is a choice again. Choosing it without one is refused
 * before the form is submitted rather than by the server.
 */
const MECHANISMS: { value: SaslMechanism | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "PLAIN", label: "PLAIN — account and password" },
  { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256 — password, never sent" },
  { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512 — password, never sent" },
  { value: "EXTERNAL", label: "EXTERNAL — client certificate" },
];

export function ServerForm({
  draft,
  advanced,
  onChange,
  onSubmit,
  onBack,
  onAdvanced,
  onRemove,
  busy,
  error,
}: Props) {
  useAnnounce(error);
  const [submitted, setSubmitted] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** An id means the network is already saved, so this is its settings rather
   * than the last step of adding it (#45). */
  const editing = draft.id !== null;
  const problems = draftProblems(draft);
  const shown = (field: keyof typeof problems, typed: string) =>
    submitted || typed.length > 0 ? (problems[field] ?? null) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (problems.host || problems.port || problems.nick || problems.clientCertificate) return;
    onSubmit();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[17px] font-medium text-[var(--text-primary)]">
          {!advanced
            ? "Connect to an IRC server"
            : editing
              ? "Network settings"
              : "Advanced setup"}
        </h1>
        <p className="text-[var(--text-secondary)]">
          {!advanced
            ? "The address and a nickname are enough. TLS and reconnect are already on."
            : editing
              ? "Every field ircx stores for this network."
              : "Every field ircx stores for a network."}
        </p>
      </header>

      {advanced && (
        <TextField
          label="Network name"
          value={draft.name}
          onChange={(name) => onChange({ name })}
          placeholder={draft.host.trim() || "Example"}
          hint="What the sidebar calls it. Defaults to the address."
        />
      )}

      <TextField
        autoFocus={!advanced}
        label="Server address"
        value={draft.host}
        onChange={(host) => onChange({ host })}
        placeholder="irc.example.org"
        error={shown("host", draft.host)}
      />

      {advanced && (
        <>
          <TextField
            label="Port"
            inputMode="numeric"
            value={draft.port}
            onChange={(port) => onChange({ port })}
            error={shown("port", draft.port)}
          />
          <CheckField
            label="Connect over TLS"
            checked={draft.tls}
            onChange={(tls) =>
              onChange({ tls, port: String(tls ? TLS_PORT : PLAIN_PORT) })
            }
          />
          {/* There is no certificate to verify on a plaintext connection, and
              a live control that governs nothing leaves the reader working out
              which of the two settings their connection is actually under. The
              value it holds is kept rather than cleared: turning TLS back on
              should restore the choice they made, not a default. */}
          {draft.tls && (
            <CheckField
              label="Verify the server's certificate"
              hint="Turn this off only for a server with a self-signed certificate you trust."
              checked={draft.tlsVerify}
              onChange={(tlsVerify) => onChange({ tlsVerify })}
            />
          )}
        </>
      )}

      <TextField
        autoFocus={advanced}
        label="Nickname"
        value={draft.nick}
        onChange={(nick) => onChange({ nick })}
        placeholder="sable"
        error={shown("nick", draft.nick)}
      />

      {advanced && (
        <>
          <TextField
            optional
            label="Alternate nicknames"
            value={draft.altNicks}
            onChange={(altNicks) => onChange({ altNicks })}
            placeholder="sable_ sable__"
            hint="Tried in order when the nickname is already taken."
          />
          <TextField
            optional
            label="Username"
            value={draft.username}
            onChange={(username) => onChange({ username })}
            placeholder={draft.nick.trim() || "sable"}
            hint="The ident half of your hostmask. Defaults to your nickname."
          />
          <TextField
            optional
            label="Real name"
            value={draft.realname}
            onChange={(realname) => onChange({ realname })}
            placeholder={draft.nick.trim() || "sable"}
            hint="Shown in WHOIS. Defaults to your nickname."
          />

          <Group title="Authentication">
            <SelectField
              label="SASL mechanism"
              value={draft.mechanism}
              options={MECHANISMS}
              onChange={(mechanism) => onChange({ mechanism })}
            />
            {draft.mechanism !== "none" && (
              <TextField
                optional
                label="Account name"
                value={draft.account}
                onChange={(account) => onChange({ account })}
                placeholder={draft.nick.trim() || "sable"}
                hint="Defaults to your nickname."
              />
            )}
            {draft.mechanism === "EXTERNAL" && (
              <CertificateField
                path={draft.clientCertificate}
                onChange={(clientCertificate) => onChange({ clientCertificate })}
                missing={shown("clientCertificate", draft.clientCertificate)}
              />
            )}
            {needsPassword(draft.mechanism) &&
              (hasStoredPassword(draft) ? (
                <StoredPassword onReplace={() => onChange({ password: "" })} />
              ) : (
                <TextField
                  label="Password"
                  type="password"
                  value={draft.password ?? ""}
                  onChange={(password) => onChange({ password })}
                  hint="Stored in your operating system's keyring, never in the database."
                />
              ))}
          </Group>

          <Group title="On connect">
            <TextField
              optional
              label="Channels to join"
              value={draft.autojoin}
              onChange={(autojoin) => onChange({ autojoin })}
              placeholder="#linux #rust"
            />
            <TextAreaField
              label="Connect commands"
              value={draft.connectCommands}
              onChange={(connectCommands) => onChange({ connectCommands })}
              placeholder="msg NickServ identify …"
              hint="One per line, sent verbatim after registration."
            />
            <CheckField
              label="Connect to this network when ircx starts"
              checked={draft.autoConnect}
              onChange={(autoConnect) => onChange({ autoConnect })}
            />
          </Group>
        </>
      )}

      {!advanced && (
        <Note>
          ircx connects over TLS on port {TLS_PORT}, negotiates IRCv3 capabilities, and
          reconnects on its own.
        </Note>
      )}

      {error && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton disabled={busy}>{busy ? "Connecting…" : "Connect"}</PrimaryButton>
        <span className="flex-1" />
        {!advanced && <LinkButton onClick={onAdvanced}>Show every setting</LinkButton>}
      </div>

      {/* Only for a network that exists to be removed. Adding one has a Back
          button; this is the settings of one already saved (#45). */}
      {editing && onRemove && (
        <div className="flex flex-col gap-1 border-t border-[var(--border-subtle)] pt-3">
          {removing ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="h-8 rounded-[var(--radius-sm)] border border-[var(--danger)] px-3 text-[12px] text-[var(--danger)] hover:bg-[var(--surface-hover)] disabled:opacity-[var(--disabled-opacity)]"
              >
                Remove {draft.name || "this network"}
              </button>
              <SecondaryButton disabled={busy} onClick={() => setRemoving(false)}>
                Keep it
              </SecondaryButton>
            </div>
          ) : (
            <LinkButton onClick={() => setRemoving(true)}>Remove this network</LinkButton>
          )}
          <Note>
            Removing it disconnects it and forgets its settings. The conversations
            already archived stay on this computer.
          </Note>
        </div>
      )}
    </form>
  );
}

/** `save_network` writes the password to the keyring and never reads it back,
 * so an empty box here would read as a lost credential. */
/** What the backend said about one path. Held together so neither half can be
 * shown against a file it did not come from. */
interface Read {
  path: string;
  fingerprint: string | null;
  problem: string | null;
}

/**
 * The PEM a network presents, and the fingerprint of it.
 *
 * The fingerprint is the point of the field. A certificate authenticates
 * nothing until the account service has been told about it — `/msg NickServ
 * CERT ADD <fingerprint>` — and a user who cannot read it here has to go and
 * ask `openssl` for the same number.
 *
 * Read through the backend on every change of path, because the frontend
 * cannot open a file and should not: what this window sees of the certificate
 * is the fingerprint and nothing else.
 */
function CertificateField({
  path,
  onChange,
  missing,
}: {
  path: string;
  onChange: (path: string) => void;
  /** Set when the mechanism needs a file and none has been named. Separate from
   * the backend's answer about the file itself, which cannot be asked yet. */
  missing: string | null;
}) {
  const wanted = path.trim();
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (wanted === "") return;
    let live = true;
    void ipc.certificateFingerprint(wanted).then(
      (fingerprint) => live && setRead({ path: wanted, fingerprint, problem: null }),
      (reason: unknown) =>
        live &&
        setRead({
          path: wanted,
          fingerprint: null,
          problem: reasonOr(reason, "That file could not be read as a certificate."),
        }),
    );
    return () => {
      live = false;
    };
  }, [wanted]);

  /* What was read stands for the path it was read from and no other, so a path
   * halfway through being typed shows nothing rather than the fingerprint of
   * the file named before it. */
  const answer = read?.path === wanted ? read : null;
  const problem = answer?.problem ?? null;
  const fingerprint = answer?.fingerprint ?? null;
  useAnnounce(problem);

  async function browse() {
    const picked = await chooseFile("Choose a certificate", [
      { name: "Certificate and key", extensions: ["pem", "crt", "p12"] },
    ]);
    if (picked !== null) onChange(picked);
  }

  return (
    <div className="flex flex-col gap-1">
      <TextField
        label="Certificate file"
        value={path}
        onChange={onChange}
        placeholder="~/.irc/libera.pem"
        hint="One PEM holding the certificate and its private key."
        error={missing}
      />
      <div className="flex items-center gap-2">
        <LinkButton onClick={() => void browse()}>Choose a file</LinkButton>
      </div>
      {problem !== null && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {problem}
        </p>
      )}
      {fingerprint !== null && (
        <div className="flex flex-col gap-1">
          {/* The command rather than the fingerprint on its own: registering it
              is the step between choosing a file and being able to log in, and
              the fingerprint is in the line to be copied with it. */}
          <p className="selectable break-all font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
            /msg NickServ CERT ADD {fingerprint}
          </p>
          <Note>Run that on the network first — until you do, it logs in nobody.</Note>
        </div>
      )}
    </div>
  );
}

function StoredPassword({ onReplace }: { onReplace: () => void }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] text-[var(--text-secondary)]">Password</p>
      <div className="flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-2.5">
        <span className="text-[12px] text-[var(--text-primary)]">
          Saved in your system keyring
        </span>
        <span className="flex-1" />
        <LinkButton onClick={onReplace}>Replace password</LinkButton>
      </div>
      <Note>ircx cannot read it back — replacing it is the only way to change it.</Note>
    </div>
  );
}
