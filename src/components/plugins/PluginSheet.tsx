import { useEffect, useRef, useState } from "react";
import { SecondaryButton } from "@/components/onboarding/fields";
import { chooseFolder, ipc, reasonOr } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { PluginGrants, PluginPermissionInfo } from "@/types";
import { PermissionsForm } from "./PermissionsForm";
import { PluginList } from "./PluginList";

/**
 * Everything the user does to a plugin, in one sheet reached from the command
 * palette: what is installed, what each one may do, and the way to add or
 * remove one. The permissions screen is the same whether it opens on an
 * install or on a plugin that has been there for months.
 */
export function PluginSheet() {
  const open = useAppStore((s) => s.pluginsOpen);
  return open ? <Sheet /> : null;
}

function Sheet() {
  const closeSheet = useAppStore((s) => s.togglePlugins);
  const plugins = useAppStore((s) => s.plugins);
  const unavailable = useAppStore((s) => s.pluginsUnavailable);

  /** The plain-terms lines, read once: they describe the permissions
   * themselves rather than any one plugin. */
  const [summaries, setSummaries] = useState<PluginPermissionInfo[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing in the sheet takes focus on its own — the list is buttons and the
  // form starts on a checkbox — so without this the keydown below fires from
  // wherever focus was left and Escape never reaches the dialog.
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  /** Closing mid-request loses the answer: an install lands with its
   * permissions never asked, and a failed save reports into a sheet that has
   * gone. */
  function close() {
    if (!busy) closeSheet(false);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={close}
    >
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Plugins"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}
        className="relative flex max-h-[88vh] w-[min(560px,92vw)] flex-col overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] shadow-[var(--shadow-overlay)]"
      >
        {editingPlugin === null ? (
          <>
            <PluginList
              plugins={plugins}
              unavailable={unavailable}
              busy={busy}
              onClose={close}
              onInstall={() => void install()}
              onPermissions={(id) => {
                // A failed install or removal belongs to the screen it happened
                // on. Carried across it would sit exactly where a rejected save
                // does and read as one.
                setError(null);
                setEditing(id);
              }}
              onRemove={(id) => void remove(id)}
            />
            {error !== null && (
              <p role="alert" className="px-6 pb-6 text-[12px] text-[var(--danger)]">
                {error}
              </p>
            )}
          </>
        ) : summaries === null ? (
          // Without the plain-terms lines the checkboxes would be labelled with
          // permission ids, which is not a question the user can answer.
          <div className="flex flex-col items-start gap-4 p-6">
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
      </div>
    </div>
  );
}

