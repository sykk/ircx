import { useCallback, useEffect, useState } from "react";
import { Group, PrimaryButton, SecondaryButton, SelectField } from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { formatBytes } from "@/lib/bytes";
import { chooseFile, chooseSavePath, ipc, reasonOr } from "@/lib/ipc";
import type { SettingsScope } from "@/components/settings/scope";
import type { ArchiveScope, ArchiveSummary } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { buildPortableProfile } from "@/lib/profileExport";
import {
  applyProfileImport,
  prepareProfileImport,
  type ProfileImportPlan,
} from "@/lib/profileImport";

/**
 * What a retention window may be set to.
 *
 * Days rather than a free number: the question is "how long do I want this
 * around", and nobody answers it in 47.
 */
const KEEP_NOTHING = "0";

const WINDOWS: { value: string; label: string }[] = [
  { value: KEEP_NOTHING, label: "Nothing — do not write it down" },
  { value: "", label: "Forever" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "A year" },
];


/** What was kept, in the words the sheet uses for it. */
export function describeKept(summary: ArchiveSummary): string {
  const messages = Number(summary.messages);
  return `${messages.toLocaleString()} message${messages === 1 ? "" : "s"}, ${formatBytes(summary.bytes)}`;
}

/**
 * The archive: how long it is kept, what it weighs, and the two ways out of it.
 *
 * It is a sheet rather than a page in the network's settings because the
 * archive is one file for the whole client, and because deleting what somebody
 * said is not a connection setting.
 */
/** What a destructive button is waiting for. Nothing is destroyed on one click. */
type Pending = { scope: ArchiveScope; what: string } | null;

export function PrivacyPage({
  here,
  onDone,
}: {
  /** The conversation this page is scoped to, or null — see
   * `src/components/settings/scope.ts`. */
  here: SettingsScope | null;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [importPlan, setImportPlan] = useState<ProfileImportPlan | null>(null);
  const [busy, setBusyHere] = useState(false);
  /* An export or a delete is a request the window must not be closed out from
     under, for the reason a plugin save is. */
  const report = useReportBusy();
  const setBusy = useCallback(
    (running: boolean) => {
      setBusyHere(running);
      report(running);
    },
    [report],
  );
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  const [said, setSaid] = useState<string | null>(null);
  // The `role="status"` below is text the page rewrites, which is the case
  // WebKitGTK reports nothing at all for — see `useAnnounce`. Only the alert
  // beside it was routed through the side channel, so an export that worked, a
  // retention that saved and an archive that was deleted all said nothing,
  // while every way of failing spoke. `succeeded` and `failed` clear each
  // other, so only ever one of these two has anything to say.
  useAnnounce(said);

  const network = here?.network ?? null;
  const target = here?.target ?? null;
  const networkName = here?.networkName ?? null;

  function read() {
    void ipc.archiveSummary(network, target).then(
      (next) => setSummary(next),
      (reason: unknown) => setError(reasonOr(reason, "The archive could not be read.")),
    );
  }

  useEffect(read, [network, target]);

  function close() {
    if (!busy) onDone();
  }

  /**
   * The page reports what the last thing you did came to, and one thing at a
   * time.
   *
   * A success used to survive every later failure, so an export refused by the
   * folder it was aimed at drew a red sentence under "Written to …" from two
   * clicks ago — one screen saying the same action both worked and did not.
   * Cancelling still reports nothing, so what is already there stays.
   */
  function succeeded(text: string) {
    setSaid(text);
    setError(null);
  }

  function failed(reason: unknown, fallback: string) {
    setError(reasonOr(reason instanceof Error ? reason.message : reason, fallback));
    setSaid(null);
  }

  async function keepFor(scope: "network" | "target", days: string) {
    if (network === null) return;
    try {
      await ipc.setRetention(
        network,
        scope === "target" ? target : null,
        days === "" ? null : Number(days),
      );
      read();
      succeeded(nowKeeping(days));
    } catch (reason) {
      failed(reason, "That could not be saved.");
    }
  }

  async function exportTo(scope: ArchiveScope, suggested: string) {
    // Dismissing the dialog and failing to open one are different answers, and
    // catching both as null is how #167 hid a refused permission for as long as
    // it did. The dialog resolves to null when the user says no and rejects
    // when it could not ask.
    let path: string | null;
    try {
      path = await chooseSavePath(suggested, [{ name: "JSON Lines", extensions: ["jsonl"] }]);
    } catch (reason) {
      failed(reason, "The save dialog could not be opened.");
      return;
    }
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const bytes = await ipc.exportArchive(scope, path);
      succeeded(`Written to ${path} — ${formatBytes(bytes)}.`);
    } catch (reason) {
      failed(reason, "The export could not be written.");
    }
    setBusy(false);
  }

  async function exportProfile() {
    let path: string | null;
    try {
      path = await chooseSavePath("ircx-profile.json", [
        { name: "JSON", extensions: ["json"] },
      ]);
    } catch (reason) {
      failed(reason, "The save dialog could not be opened.");
      return;
    }
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const profile = await buildPortableProfile();
      const bytes = await ipc.exportProfile(path, `${JSON.stringify(profile, null, 2)}\n`);
      succeeded(`Profile written to ${path} — ${formatBytes(bytes)}.`);
    } catch (reason) {
      failed(reason, "The profile could not be written.");
    }
    setBusy(false);
  }

  async function chooseProfile() {
    let path: string | null;
    try {
      path = await chooseFile("Import an ircx profile", [
        { name: "JSON", extensions: ["json"] },
      ]);
    } catch (reason) {
      failed(reason, "The file dialog could not be opened.");
      return;
    }
    if (path === null) return;

    setBusy(true);
    try {
      const plan = await prepareProfileImport(await ipc.readProfile(path));
      setImportPlan(plan);
      setError(null);
      setSaid(null);
    } catch (reason) {
      failed(reason, "That profile could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function importProfile() {
    if (importPlan === null) return;
    setBusy(true);
    try {
      const imported = await applyProfileImport(importPlan);
      const networks = imported.added + imported.updated;
      succeeded(
        `Profile imported: ${networks} network${networks === 1 ? "" : "s"}, ${imported.muted} mute${imported.muted === 1 ? "" : "s"}, appearance and notifications.`,
      );
      setImportPlan(null);
    } catch (reason) {
      failed(
        reason,
        "The profile stopped while it was being imported. Changes already applied remain.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (pending === null) return;
    setBusy(true);
    try {
      await ipc.deleteArchive(pending.scope);
      succeeded(`${pending.what} deleted. There is no undo, and there was none.`);
      setPending(null);
      read();
    } catch (reason) {
      failed(reason, "That could not be deleted.");
    }
    setBusy(false);
  }

  return (
    <SettingsPage
      title="Privacy"
      blurb={
        <>
          <p>
            {summary === null
              ? "Reading what is kept…"
              : `${describeKept(summary)} on this machine.`}
          </p>
          {summary !== null && summary.removedOnLaunch > 0n && (
            <p>
              {Number(summary.removedOnLaunch).toLocaleString()} were removed when ircx started,
              past the window below.
            </p>
          )}
        </>
      }
      onDone={close}
    >
      <div className="flex max-w-[560px] flex-col gap-4">

          {network === null ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              Open a conversation in the client and come back to set how long it is kept.
              Everything below still applies to the whole archive.
            </p>
          ) : (
            <Group title="How long to keep">
              <SelectField
                label={`Everything on ${networkName}`}
                value={summary?.networkDays === null ? "" : String(summary?.networkDays ?? "")}
                options={WINDOWS}
                onChange={(days) => void keepFor("network", days)}
              />
              {target !== null && (
                <SelectField
                  label={`${target}, if it should differ`}
                  value={
                    summary?.targetOverride ? String(summary.targetDays ?? "") : FOLLOWS_NETWORK
                  }
                  options={[{ value: FOLLOWS_NETWORK, label: "Same as the network" }, ...WINDOWS]}
                  onChange={(days) =>
                    days === FOLLOWS_NETWORK ? undefined : void keepFor("target", days)
                  }
                />
              )}
            </Group>
          )}

          <Group title="Take a copy">
            <p className="text-[12px] text-[var(--text-muted)]">
              JSON Lines, one message per line, oldest first. Re-readable by anything, including
              ircx.
            </p>
            <div className="flex flex-wrap gap-2">
              {network !== null && target !== null && (
                <SecondaryButton
                  onClick={() =>
                    void exportTo({ type: "conversation", network, target }, `${target}.jsonl`)
                  }
                  disabled={busy}
                >
                  Export {target}
                </SecondaryButton>
              )}
              {network !== null && (
                <SecondaryButton
                  onClick={() =>
                    void exportTo({ type: "network", network }, `${network}.jsonl`)
                  }
                  disabled={busy}
                >
                  Export {networkName ?? network}
                </SecondaryButton>
              )}
              <SecondaryButton
                onClick={() => void exportTo({ type: "everything" }, "ircx-archive.jsonl")}
                disabled={busy}
              >
                Export everything
              </SecondaryButton>
            </div>
          </Group>

          <Group title="Move your setup">
            <p className="text-[12px] text-[var(--text-muted)]">
              A versioned JSON profile with networks, autojoins, appearance, notifications,
              upload settings, and a plugin inventory.
            </p>
            <p className="text-[12px] text-[var(--text-muted)]">
              Passwords, upload credentials and form fields, certificate paths, connect commands,
              history, drafts, custom theme files, plugin code, and plugin data stay on this
              computer.
            </p>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={() => void exportProfile()} disabled={busy}>
                Export profile
              </SecondaryButton>
              <SecondaryButton onClick={() => void chooseProfile()} disabled={busy}>
                Import profile
              </SecondaryButton>
            </div>
            {importPlan !== null && (
              <section
                aria-labelledby="profile-import-preview"
                className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-3"
              >
                <div className="flex flex-col gap-1">
                  <h3
                    id="profile-import-preview"
                    className="text-[13px] font-medium text-[var(--text-primary)]"
                  >
                    Review this profile
                  </h3>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Existing networks and mutes not named here stay. Imported networks are saved
                    without connecting during this import.
                  </p>
                </div>

                <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-[var(--text-muted)]">Networks</dt>
                  <dd>
                    {importPlan.networks.filter((network) => network.action === "add").length} to
                    add, {importPlan.networks.filter((network) => network.action === "update").length}
                    {" "}to update
                  </dd>
                  {importPlan.networks.some((network) => network.authentication === "manual") && (
                    <>
                      <dt className="text-[var(--text-muted)]">Sign-in</dt>
                      <dd>
                        Configure {importPlan.networks
                          .filter((network) => network.authentication === "manual")
                          .map((network) => network.config.name)
                          .join(", ")} manually
                      </dd>
                    </>
                  )}
                  <dt className="text-[var(--text-muted)]">Appearance</dt>
                  <dd>
                    {importPlan.profile.appearance.theme}, {importPlan.profile.appearance.density}
                    {importPlan.selectedThemeAvailable ? "" : " — theme unavailable, current theme stays"}
                  </dd>
                  <dt className="text-[var(--text-muted)]">Notifications</dt>
                  <dd>
                    {importPlan.profile.notifications.highlightWords.length} highlight word
                    {importPlan.profile.notifications.highlightWords.length === 1 ? "" : "s"},{" "}
                    {importPlan.mutes.length} mute{importPlan.mutes.length === 1 ? "" : "s"}
                  </dd>
                  <dt className="text-[var(--text-muted)]">Uploads</dt>
                  <dd>
                    {importPlan.upload.action === "save"
                      ? "Credential-free provider will be restored"
                      : importPlan.upload.action === "manual"
                        ? "Provider needs fields or credentials; configure it manually"
                        : "Current provider stays"}
                  </dd>
                </dl>

                {(importPlan.missingThemes.length > 0 ||
                  importPlan.missingPlugins.length > 0 ||
                  importPlan.skippedMutes > 0) && (
                  <ul className="list-disc pl-4 text-[11px] text-[var(--warning)]">
                    {importPlan.missingThemes.length > 0 && (
                      <li>Install these theme folders separately: {importPlan.missingThemes.join(", ")}.</li>
                    )}
                    {importPlan.missingPlugins.length > 0 && (
                      <li>Install these plugins separately: {importPlan.missingPlugins.join(", ")}.</li>
                    )}
                    {importPlan.skippedMutes > 0 && (
                      <li>
                        {importPlan.skippedMutes} mute{importPlan.skippedMutes === 1 ? "" : "s"}{" "}
                        could not be matched to one imported network.
                      </li>
                    )}
                  </ul>
                )}

                <p className="text-[11px] text-[var(--text-muted)]">
                  Passwords, certificates, connect commands, theme files, plugin code and plugin
                  permissions are not imported. Re-enter them where needed.
                </p>
                <div className="flex gap-2">
                  <PrimaryButton onClick={() => void importProfile()} disabled={busy}>
                    Import profile
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setImportPlan(null)} disabled={busy}>
                    Cancel
                  </SecondaryButton>
                </div>
              </section>
            )}
          </Group>

          <Group title="Delete">
            {pending === null ? (
              <div className="flex flex-wrap gap-2">
                {network !== null && target !== null && (
                  <SecondaryButton
                    onClick={() =>
                      setPending({
                        scope: { type: "conversation", network, target },
                        what: target,
                      })
                    }
                    disabled={busy}
                  >
                    Delete {target}
                  </SecondaryButton>
                )}
                {network !== null && (
                  <SecondaryButton
                    onClick={() =>
                      setPending({
                        scope: { type: "network", network },
                        what: networkName ?? network,
                      })
                    }
                    disabled={busy}
                  >
                    Delete {networkName ?? network}
                  </SecondaryButton>
                )}
                <SecondaryButton
                  onClick={() =>
                    setPending({ scope: { type: "everything" }, what: "The whole archive" })
                  }
                  disabled={busy}
                >
                  Delete everything
                </SecondaryButton>
              </div>
            ) : (
              <div className="flex flex-col gap-2" role="alertdialog" aria-label="Confirm delete">
                <p className="text-[12px]">
                  {pending.scope.type === "everything"
                    ? `Delete ${summary === null ? "the whole archive" : describeKept(summary)}? Your networks and passwords stay; everything anybody said goes.`
                    : `Delete everything kept from ${pending.what}?`}{" "}
                  This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <PrimaryButton onClick={() => void destroy()} disabled={busy}>
                    Delete
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setPending(null)} disabled={busy}>
                    Keep it
                  </SecondaryButton>
                </div>
              </div>
            )}
          </Group>

        {said !== null && (
          <p className="text-[12px] text-[var(--text-muted)]" role="status">
            {said}
          </p>
        )}
        {error !== null && (
          <p className="text-[12px] text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
      </div>
    </SettingsPage>
  );
}

/** Distinct from "forever", which is a window this conversation states itself. */
const FOLLOWS_NETWORK = "follows";

/**
 * What the window just chosen means, said once rather than left to be inferred.
 *
 * The keep-nothing case earns its sentence: messages still arrive and are still
 * drawn, and a conversation that empties when the app closes reads as a bug the
 * first time somebody meets it. #249.
 */
export function nowKeeping(days: string): string {
  if (days === KEEP_NOTHING) {
    return "Nothing is written down. Conversations still arrive and are still drawn — they are gone when ircx closes, and scrolling back finds nothing.";
  }
  if (days === "") return "Kept forever. Nothing is removed until this changes.";
  return `Kept for ${days} days. Messages past that go on the next launch.`;
}
