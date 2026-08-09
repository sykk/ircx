import { useCallback, useEffect, useState } from "react";
import { Group, PrimaryButton, SecondaryButton, SelectField } from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { formatBytes } from "@/lib/bytes";
import { chooseSavePath, ipc, reasonOr } from "@/lib/ipc";
import type { SettingsScope } from "@/lib/settingsWindow";
import type { ArchiveScope, ArchiveSummary } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";

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
  /** The conversation the client was on when this window was asked for, or
   * null. Handed over rather than read from the store: this window runs no
   * event bridge, so it has no conversations of its own — see
   * src/lib/settingsWindow.ts. */
  here: SettingsScope | null;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [pending, setPending] = useState<Pending>(null);
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
    setError(reasonOr(reason, fallback));
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
              <SecondaryButton
                onClick={() => void exportTo({ type: "everything" }, "ircx-archive.jsonl")}
                disabled={busy}
              >
                Export everything
              </SecondaryButton>
            </div>
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

