import { useCallback, useEffect, useState } from "react";
import {
  Group,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TextField,
} from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { ipc, reasonOr } from "@/lib/ipc";
import type { UploadProvider } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";

/** How the file is put in the request. The first two send it as the body, which
 * is what storage and self-hosted boxes take; the third sends it in a field,
 * which is what the hosts that ask for no account take. */
type Shape = "put" | "post" | "form";

const SHAPES: { value: Shape; label: string }[] = [
  { value: "put", label: "PUT — the address names the file" },
  { value: "post", label: "POST — the provider names the file" },
  { value: "form", label: "POST a form — the host takes an upload form" },
];

/** How the provider is convinced to accept the file. Two answers, and they
 * share nothing: one sends a credential, the other proves it holds one. */
type Kind = "header" | "s3";

const KINDS: { value: Kind; label: string }[] = [
  { value: "header", label: "A token in a header" },
  { value: "s3", label: "S3-compatible, signed" },
];

/** Which credential this provider carries, or `null` for one that needs none —
 * a self-hosted box behind a VPN. The backend asks the same of what it is
 * given and refuses to save a provider whose answer it cannot meet. */
function needs(kind: Kind, authHeader: string): Kind | null {
  if (kind === "s3") return "s3";
  return authHeader.trim() === "" ? null : "header";
}

/** What the saved secret is for, when there is one. The two kinds share one
 * keyring slot and nothing else, so a token saved for a header is not a secret
 * a signer has. */
function savedFor(provider: UploadProvider): Kind | null {
  return provider.tokenSaved === true
    ? needs(provider.s3 ? "s3" : "header", provider.authHeader ?? "")
    : null;
}

/** What the form holds, which is not what is stored: the secret is write-only,
 * so the field starts empty and an empty field means "leave it alone". */
interface Draft {
  endpoint: string;
  shape: Shape;
  kind: Kind;
  authHeader: string;
  region: string;
  accessKeyId: string;
  token: string;
  fileField: string;
  fields: string;
}

const EMPTY: Draft = {
  endpoint: "",
  shape: "put",
  kind: "header",
  authHeader: "Authorization",
  region: "us-east-1",
  accessKeyId: "",
  token: "",
  fileField: "fileToUpload",
  fields: "",
};

/** `reqtype=fileupload, time=1h` as the host wants it, in the order it was
 * typed. A pair with no `=` is a name the user has not finished typing, not a
 * field with an empty value, so it waits rather than being sent. */
function parseFields(text: string): [string, string][] {
  return text
    .split(",")
    .map((pair) => pair.split("="))
    .flatMap(([name, ...rest]) =>
      name === undefined || name.trim() === "" || rest.length === 0
        ? []
        : [[name.trim(), rest.join("=").trim()] as [string, string]],
    );
}

function showFields(fields: [string, string][]): string {
  return fields.map(([name, value]) => `${name}=${value}`).join(", ");
}

/**
 * Where attachments go before their link is sent.
 *
 * One provider for the whole client rather than one per network: it is storage,
 * and which server a conversation is on says nothing about where a file should
 * live. No provider at all is a configuration the spec names — the user sends
 * links they made elsewhere — so this sheet can be left empty and removing the
 * provider is a button rather than a blank endpoint.
 */
export function UploadsPage({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stored, setStored] = useState(false);
  /** What the secret in the keyring is for, and so which draft it answers. */
  const [saved, setSaved] = useState<Kind | null>(null);
  const [busy, setBusyHere] = useState(false);
  /* The window's Escape is caught on the document, above every page, so a
     page cannot guard its own way out — it says it is busy instead. */
  const report = useReportBusy();
  const setBusy = useCallback(
    (running: boolean) => {
      setBusyHere(running);
      report(running);
    },
    [report],
  );
  const [error, setError] = useState<string | null>(null);
  /** What just happened, kept until the next edit. As a sheet this page said
   * it by closing; a page in a window that stays open has to say it in
   * words. */
  const [said, setSaid] = useState<string | null>(null);
  useAnnounce(error ?? said);

  useEffect(() => {
    let live = true;
    void ipc.getUploadProvider().then(
      (provider) => {
        if (!live) return;
        setStored(provider !== null);
        setSaved(provider === null ? null : savedFor(provider));
        setDraft(provider === null ? EMPTY : fromProvider(provider));
      },
      (reason: unknown) => {
        if (live) setError(reasonOr(reason, "The provider could not be read."));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /** Closing mid-request loses the answer, as it does on the plugins page. */
  function close() {
    if (!busy) onDone();
  }

  async function save() {
    if (draft === null) return;
    setSaid(null);
    const endpoint = draft.endpoint.trim();
    if (endpoint === "") {
      setError("An address is needed. Remove the provider instead to send no files.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const signing = draft.kind === "s3";
      if (signing && draft.accessKeyId.trim() === "") {
        setError("An access key id is needed to sign the request.");
        setBusy(false);
        return;
      }
      const asForm = !signing && draft.shape === "form";
      if (asForm && draft.fileField.trim() === "") {
        setError("A form upload needs the name of the field the file goes in.");
        setBusy(false);
        return;
      }
      await ipc.saveUploadProvider({
        endpoint,
        // A signature covers the method, so a signed upload is a PUT and the
        // choice does not apply to it. A form is a POST for the same reason:
        // the field names are part of the request.
        method: signing || draft.shape === "put" ? "PUT" : "POST",
        authHeader: signing ? null : draft.authHeader.trim() || null,
        // Empty means the stored one stands, which is what lets the endpoint be
        // corrected without retyping a secret nobody can see.
        token: draft.token === "" ? null : draft.token,
        s3: signing
          ? { region: draft.region.trim() || "us-east-1", accessKeyId: draft.accessKeyId.trim() }
          : null,
        form: asForm
          ? { fileField: draft.fileField.trim(), fields: parseFields(draft.fields) }
          : null,
      });
      setStored(true);
      /* The secret is written to the keyring by `save_network`'s counterpart
       * and never read back, so what the field can honestly say about it
       * changes here rather than on the next read. */
      setSaved(needs(draft.kind, draft.token) === null ? saved : draft.kind);
      setSaid("Saved.");
    } catch (reason) {
      setError(reasonOr(reason, "The provider could not be saved."));
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await ipc.removeUploadProvider();
      setStored(false);
      setSaved(null);
      setDraft(EMPTY);
      setSaid("Removed. ircx will send no files until a provider is set.");
    } catch (reason) {
      setError(reasonOr(reason, "The provider could not be removed."));
      setBusy(false);
    }
  }

  return (
    <SettingsPage
      title="Uploads"
      blurb="Files are sent here and the link goes to the conversation. Without a provider, ircx sends no files — only links you already have."
      onDone={close}
    >
      {draft === null ? (
        <div>
          {error === null ? (
            <p className="text-[12px] text-[var(--text-muted)]">Reading the provider…</p>
          ) : (
            <p role="alert" className="text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="flex max-w-[560px] flex-col gap-4">

            <Group title="Where files go">
              <TextField
                label="Address"
                value={draft.endpoint}
                onChange={(endpoint) => setDraft({ ...draft, endpoint })}
                placeholder="https://files.example.com/{name}"
                hint="{name} is replaced with a generated file name. Leave it out if the provider names the file itself."
              />
              {/* A signature covers the method, so a signed upload is a PUT
                  and offering the choice would offer a request nobody can make. */}
              {draft.kind === "header" && (
                <SelectField
                  label="Method"
                  value={draft.shape}
                  options={SHAPES}
                  onChange={(shape) => setDraft({ ...draft, shape })}
                />
              )}
              {draft.kind === "header" && draft.shape === "form" && (
                <>
                  <TextField
                    label="File field"
                    value={draft.fileField}
                    onChange={(fileField) => setDraft({ ...draft, fileField })}
                    placeholder="fileToUpload"
                    hint="The field the file goes in. `fileToUpload` for catbox and litterbox, `file` for the 0x0.st family."
                  />
                  <TextField
                    optional
                    label="Other fields"
                    value={draft.fields}
                    onChange={(fields) => setDraft({ ...draft, fields })}
                    placeholder="reqtype=fileupload, time=1h"
                    hint="Whatever else the host wants told, sent in the order you type them."
                  />
                </>
              )}
            </Group>

            <Group title="Credential">
              <SelectField
                label="Kind"
                value={draft.kind}
                options={KINDS}
                onChange={(kind) => setDraft({ ...draft, kind })}
              />

              {draft.kind === "header" ? (
                <TextField
                  optional
                  label="Header"
                  value={draft.authHeader}
                  onChange={(authHeader) => setDraft({ ...draft, authHeader })}
                  placeholder="Authorization"
                  hint="Leave empty for a provider that needs no credential."
                />
              ) : (
                <>
                  <TextField
                    label="Access key id"
                    value={draft.accessKeyId}
                    onChange={(accessKeyId) => setDraft({ ...draft, accessKeyId })}
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                  />
                  <TextField
                    label="Region"
                    value={draft.region}
                    onChange={(region) => setDraft({ ...draft, region })}
                    placeholder="us-east-1"
                    hint="Part of the signature. A provider that ignores regions still needs the one it expects."
                  />
                </>
              )}

              <TextField
                optional={needs(draft.kind, draft.authHeader) === null}
                label={draft.kind === "s3" ? "Secret access key" : "Token"}
                type="password"
                value={draft.token}
                onChange={(token) => setDraft({ ...draft, token })}
                hint={secretHint(needs(draft.kind, draft.authHeader), saved)}
              />
            </Group>

            {error !== null && (
              <p role="alert" className="text-[12px] text-[var(--danger)]">
                {error}
              </p>
            )}

            {said !== null && (
              <p className="text-[12px] text-[var(--text-muted)]">{said}</p>
            )}

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={busy} onClick={() => void save()}>
                Save
              </PrimaryButton>
              {stored && (
                <span className="ml-auto">
                  <SecondaryButton disabled={busy} onClick={() => void remove()}>
                    Remove provider
                  </SecondaryButton>
                </span>
              )}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}

/** What the field can honestly say about the keyring.
 *
 * It used to say "saved" whenever a provider was saved, which is a different
 * question: a provider saved without its secret claimed to have one and then
 * failed on the first file. */
function secretHint(wanted: Kind | null, saved: Kind | null): string {
  if (wanted !== null && wanted === saved) {
    return "Saved in your system keyring. Leave empty to keep it.";
  }
  if (wanted !== null && saved !== null) {
    return "The secret in your keyring is for the other kind of provider and cannot stand in for this one.";
  }
  return "Stored in your operating system's keyring, never in the database.";
}

function fromProvider(provider: UploadProvider): Draft {
  return {
    endpoint: provider.endpoint,
    shape: provider.form ? "form" : provider.method === "PUT" ? "put" : "post",
    kind: provider.s3 ? "s3" : "header",
    authHeader: provider.authHeader ?? "",
    region: provider.s3?.region ?? EMPTY.region,
    accessKeyId: provider.s3?.accessKeyId ?? "",
    token: "",
    fileField: provider.form?.fileField ?? EMPTY.fileField,
    fields: showFields(provider.form?.fields ?? []),
  };
}

