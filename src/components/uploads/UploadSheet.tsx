import { useEffect, useRef, useState } from "react";
import {
  Group,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TextField,
} from "@/components/onboarding/fields";
import { ipc, reasonOr } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { UploadMethod, UploadProvider } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useDialogFocus } from "@/hooks/useDialogFocus";

const METHODS: { value: UploadMethod; label: string }[] = [
  { value: "PUT", label: "PUT — the address names the file" },
  { value: "POST", label: "POST — the provider names the file" },
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
  method: UploadMethod;
  kind: Kind;
  authHeader: string;
  region: string;
  accessKeyId: string;
  token: string;
}

const EMPTY: Draft = {
  endpoint: "",
  method: "PUT",
  kind: "header",
  authHeader: "Authorization",
  region: "us-east-1",
  accessKeyId: "",
  token: "",
};

/**
 * Where attachments go before their link is sent.
 *
 * One provider for the whole client rather than one per network: it is storage,
 * and which server a conversation is on says nothing about where a file should
 * live. No provider at all is a configuration the spec names — the user sends
 * links they made elsewhere — so this sheet can be left empty and removing the
 * provider is a button rather than a blank endpoint.
 */
export function UploadSheet() {
  const open = useAppStore((s) => s.uploadOpen);
  return open ? <Sheet /> : null;
}

function Sheet() {
  const closeSheet = useAppStore((s) => s.toggleUpload);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stored, setStored] = useState(false);
  /** What the secret in the keyring is for, and so which draft it answers. */
  const [saved, setSaved] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);

  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

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

  /** Closing mid-request loses the answer, as it does in the plugin sheet. */
  function close() {
    if (!busy) closeSheet(false);
  }

  async function save() {
    if (draft === null) return;
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
      await ipc.saveUploadProvider({
        endpoint,
        // A signature covers the method, so a signed upload is a PUT and the
        // choice does not apply to it.
        method: signing ? "PUT" : draft.method,
        authHeader: signing ? null : draft.authHeader.trim() || null,
        // Empty means the stored one stands, which is what lets the endpoint be
        // corrected without retyping a secret nobody can see.
        token: draft.token === "" ? null : draft.token,
        s3: signing
          ? { region: draft.region.trim() || "us-east-1", accessKeyId: draft.accessKeyId.trim() }
          : null,
      });
      closeSheet(false);
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
      closeSheet(false);
    } catch (reason) {
      setError(reasonOr(reason, "The provider could not be removed."));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onMouseDown={close}>
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Upload provider"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}
        className="relative flex max-h-[88vh] w-[min(560px,92vw)] flex-col overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] shadow-[var(--shadow-overlay)]"
      >
        {draft === null ? (
          <div className="p-6">
            {error === null ? (
              <p className="text-[12px] text-[var(--text-muted)]">Reading the provider…</p>
            ) : (
              <p role="alert" className="text-[12px] text-[var(--danger)]">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-6">
            <h2 className="text-[15px] font-semibold">Upload provider</h2>
            <p className="text-[12px] text-[var(--text-muted)]">
              Files are sent here and the link goes to the conversation. Without a provider,
              ircx sends no files — only links you already have.
            </p>

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
                  value={draft.method}
                  options={METHODS}
                  onChange={(method) => setDraft({ ...draft, method })}
                />
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

            <div className="flex items-center gap-2">
              <PrimaryButton disabled={busy} onClick={() => void save()}>
                Save
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={close}>
                Cancel
              </SecondaryButton>
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
      </div>
    </div>
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
    method: provider.method,
    kind: provider.s3 ? "s3" : "header",
    authHeader: provider.authHeader ?? "",
    region: provider.s3?.region ?? EMPTY.region,
    accessKeyId: provider.s3?.accessKeyId ?? "",
    token: "",
  };
}

