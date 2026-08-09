import { useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/onboarding/fields";
import type { InstalledPlugin } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { grantLine } from "@/components/plugins/grants";

/**
 * What is installed, and the three things that can be done to it: install
 * another, change what one holds, remove one. Removal asks first, because a
 * plugin's grants go with it and nothing brings them back.
 */
export function PluginList({
  plugins,
  unavailable,
  busy,
  onInstall,
  onPermissions,
  onRemove,
}: {
  plugins: readonly InstalledPlugin[];
  /** Why the library could not be read, or null. Different from no plugins. */
  unavailable: string | null;
  busy: boolean;
  onInstall: () => void;
  onPermissions: (plugin: string) => void;
  onRemove: (plugin: string) => void;
}) {
  useAnnounce(unavailable);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {/* The page's own heading is above this; what belongs to the list is the
          way to add to it. */}
      <div className="flex">
        <PrimaryButton type="button" disabled={busy} onClick={onInstall}>
          Install from folder
        </PrimaryButton>
      </div>

      {unavailable !== null ? (
        <p role="alert" className="text-[12px] text-[var(--warning)]">
          {unavailable}
        </p>
      ) : plugins.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)]">
          Nothing installed. A plugin is a folder holding a plugin.json and the
          script it names.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
          {plugins.map((plugin) => (
            <li key={plugin.id} className="flex items-start justify-between gap-4 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
                  {plugin.name}{" "}
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {plugin.version}
                  </span>
                </h3>
                <p className="text-[12px] text-[var(--text-secondary)]">
                  {plugin.description}
                </p>

                {plugin.commands.map((command) => (
                  <p key={command.name} className="text-[11px] text-[var(--text-muted)]">
                    <span className="font-mono text-[var(--text-secondary)]">
                      /{command.name}
                    </span>{" "}
                    {command.summary}
                  </p>
                ))}

                <p
                  className={
                    plugin.grants.permissions.length === 0
                      ? "text-[11px] text-[var(--warning)]"
                      : "text-[11px] text-[var(--text-muted)]"
                  }
                >
                  {grantLine(plugin)}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {confirming === plugin.id ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Remove ${plugin.name} and its permissions`}
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        onRemove(plugin.id);
                      }}
                      className="h-8 rounded-[var(--radius-sm)] border border-[var(--danger)] px-3 text-[12px] text-[var(--danger)] hover:bg-[var(--surface-hover)] disabled:opacity-[var(--disabled-opacity)]"
                    >
                      Remove
                    </button>
                    <SecondaryButton
                      label={`Keep ${plugin.name}`}
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </SecondaryButton>
                  </>
                ) : (
                  <>
                    <SecondaryButton
                      label={`Permissions for ${plugin.name}`}
                      disabled={busy}
                      onClick={() => onPermissions(plugin.id)}
                    >
                      Permissions
                    </SecondaryButton>
                    <SecondaryButton
                      label={`Remove ${plugin.name}`}
                      disabled={busy}
                      onClick={() => setConfirming(plugin.id)}
                    >
                      Remove
                    </SecondaryButton>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
