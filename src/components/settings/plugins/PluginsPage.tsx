import { useCallback, useEffect, useState } from "react";
import { SecondaryButton } from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { chooseFolder, ipc, reasonOr } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { PluginGrants, PluginPermissionInfo } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { PermissionsForm } from "./PermissionsForm";
import { PluginList } from "./PluginList";

/**
 * Everything the user does to a plugin: what is installed, what each one may
 * do, and the way to add or remove one. The permissions screen is the same
 * whether it opens on an install or on a plugin that has been there for
 * months.
 *
 * Every change here is announced to the client, which has no plugin screen of
 * its own any more but does count them in its status bar. Installing runs in
 * the backend, so the client cannot see it happen — nothing would be wrong on
 * screen except a number that stayed where it was.
 */
export function PluginsPage({ onDone }: { onDone: () => void }) {
  const plugins = useAppStore((s) => s.plugins);
  const unavailable = useAppStore((s) => s.pluginsUnavailable);

  /** The plain-terms lines, read once: they describe the permissions
   * themselves rather than any one plugin. */
  const [summaries, setSummaries] = useState<PluginPermissionInfo[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
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
  useAnnounce(error);

  /** Closing mid-request loses the answer: an install lands with its
   * permissions never asked, and a failed save reports into a page that has
   * gone. */
  function close() {
    if (!busy) onDone();
  }

  useEffect(() => {
    let live = true;
    void ipc.pluginPermissions().then(
      (permissions) => {
        if (live) setSummaries(permissions);
      },
      (reason: unknown) => {
        if (live) setError(reasonOr(reason, "The permissions could not be read."));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const editingPlugin = plugins.find((plugin) => plugin.id === editing) ?? null;

  async function install() {
    setError(null);

    let source: string | null;
    try {
      source = await chooseFolder("Choose a plugin folder");
    } catch (reason) {
      setError(reasonOr(reason, "The folder picker could not be opened."));
      return;
    }
    if (source === null) return;

    setBusy(true);
    try {
      const installed = await ipc.installPlugin(source);
      useAppStore.getState().upsertPlugin(installed);
      // Installing grants nothing, so the permissions are what the user is
      // asked about the moment a plugin lands.
      setEditing(installed.id);
    } catch (reason) {
      setError(reasonOr(reason, "The plugin could not be installed."));
    }
    setBusy(false);
  }

  async function remove(id: string) {
    setError(null);
    setBusy(true);
    try {
      await ipc.removePlugin(id);
      useAppStore.getState().dropPlugin(id);
    } catch (reason) {
      setError(reasonOr(reason, "The plugin could not be removed."));
    }
    setBusy(false);
  }

  async function save(id: string, grants: PluginGrants) {
    setError(null);
    setBusy(true);
    try {
      useAppStore.getState().upsertPlugin(await ipc.setPluginGrants(id, grants));
      setEditing(null);
    } catch (reason) {
      setError(reasonOr(reason, "The permissions could not be saved."));
    }
    setBusy(false);
  }

  /* The permissions screen replaces the page rather than sitting under it, as
   * it did in the sheet: it is a question about one plugin and the list behind
   * it is not part of the answer. */
  if (editingPlugin !== null) {
    return (
      <SettingsPage
        title={editingPlugin.name}
        blurb="What this plugin is allowed to do."
        onDone={close}
      >
        {summaries === null ? (
          // Without the plain-terms lines the checkboxes would be labelled with
          // permission ids, which is not a question the user can answer.
          <div className="flex flex-col items-start gap-4">
            {error === null ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                Reading what the permissions mean…
              </p>
            ) : (
              <p role="alert" className="text-[12px] text-[var(--danger)]">
                {error}
              </p>
            )}
            <SecondaryButton onClick={() => setEditing(null)}>Back</SecondaryButton>
          </div>
        ) : (
          <PermissionsForm
            plugin={editingPlugin}
            summaries={summaries}
            error={error}
            busy={busy}
            onSave={(grants) => void save(editingPlugin.id, grants)}
            onCancel={() => {
              setError(null);
              setEditing(null);
            }}
          />
        )}
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Plugins"
      blurb="A plugin is a folder holding a plugin.json and the script it names. Installing one grants it nothing."
      onDone={close}
    >
      <PluginList
        plugins={plugins}
        unavailable={unavailable}
        busy={busy}
        onInstall={() => void install()}
        onPermissions={(id) => {
          // A failed install or removal belongs to the screen it happened on.
          // Carried across it would sit exactly where a rejected save does and
          // read as one.
          setError(null);
          setEditing(id);
        }}
        onRemove={(id) => void remove(id)}
      />
      {error !== null && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
