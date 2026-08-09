import { useState } from "react";
import { useAnnounce } from "@/hooks/useAnnounce";
import {
  CheckField,
  Note,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "@/components/onboarding/fields";
import type {
  InstalledPlugin,
  PluginGrants,
  PluginPermission,
  PluginPermissionInfo,
} from "@/types";
import {
  allowsNaming,
  EVERY_CONVERSATION,
  needsChannels,
  offeredChannels,
  reachesAnyChannel,
  scopeOf,
  toggleChannel,
  toggleHost,
  togglePermission,
  unscoped,
} from "@/components/plugins/grants";

/**
 * What a plugin may do, offered as exactly what its manifest asked for and
 * never more. The same screen is how a grant is taken back: revoking is
 * granting less, submitted through the same call.
 *
 * The plain-terms line under each permission is `PluginPermissionInfo.summary`,
 * written once in `ircx-plugin` and rendered here as it arrives.
 */
export function PermissionsForm({
  plugin,
  summaries,
  error,
  busy,
  onSave,
  onCancel,
}: {
  plugin: InstalledPlugin;
  summaries: readonly PluginPermissionInfo[];
  error: string | null;
  busy: boolean;
  onSave: (grants: PluginGrants) => void;
  onCancel: () => void;
}) {
  useAnnounce(error);
  const [draft, setDraft] = useState<PluginGrants>(plugin.grants);
  const asked = plugin.requests;
  /* #163. Held here rather than inside the input, so saving can see it. A name
   * typed and not added reached nothing, and the grant saved as whatever the
   * manifest had asked for — `*` for a plugin that asked for every
   * conversation. The user had narrowed the scope and the client widened it
   * back without saying so. */
  const [pending, setPending] = useState("");
  const unresolved = pending.trim() !== "";

  return (
    <form
      className="flex flex-col gap-4 p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unscoped(draft) && !unresolved) onSave(draft);
      }}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)]">
          What {plugin.name} may do
        </h2>
        <p className="text-[12px] text-[var(--text-secondary)]">{plugin.description}</p>
      </header>

      {asked.permissions.length === 0 ? (
        <Note>{plugin.name} asks for nothing, so there is nothing to allow.</Note>
      ) : (
        <ul className="flex flex-col gap-3">
          {asked.permissions.map((permission) => {
            const allowed = draft.permissions.includes(permission);
            const scope = scopeOf(permission);
            // Allowed, but there is nowhere for it to happen. Said here rather
            // than left as a Save button that will not press.
            const nowhere =
              allowed && needsChannels(permission) && !reachesAnyChannel(draft);
            return (
              <li key={permission} className="flex flex-col gap-2">
                <CheckField
                  label={summaryOf(summaries, permission)}
                  checked={allowed}
                  onChange={() => setDraft(togglePermission(draft, permission))}
                />
                {nowhere && (
                  <p className="ml-[22px] text-[11px] text-[var(--warning)]">
                    This reaches nothing until you choose the conversations it
                    may work in, below.
                  </p>
                )}
                {allowed && scope === "channels" && (
                  <Scope
                    legend="Conversations"
                    empty="This plugin names no conversation it could work in."
                    missing="Choose at least one conversation."
                    offered={offeredChannels(asked.channels, draft.channels)}
                    chosen={draft.channels}
                    nameOf={(channel) =>
                      channel === EVERY_CONVERSATION ? "Every conversation" : channel
                    }
                    onToggle={(channel) => setDraft(toggleChannel(draft, channel))}
                    onName={
                      allowsNaming(asked.channels)
                        ? (channel) => setDraft(toggleChannel(draft, channel))
                        : undefined
                    }
                    pending={pending}
                    onPending={setPending}
                  />
                )}
                {allowed && scope === "hosts" && (
                  <Scope
                    legend="Websites"
                    empty="This plugin names no website it could reach."
                    missing="Choose at least one website."
                    offered={asked.hosts}
                    chosen={draft.hosts}
                    onToggle={(host) => setDraft(toggleHost(draft, host))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <PrimaryButton disabled={busy || unscoped(draft) || unresolved}>Save</PrimaryButton>
        <SecondaryButton onClick={onCancel}>Back</SecondaryButton>
      </div>
    </form>
  );
}

/** The channels or hosts a scoped permission may reach, offered as the manifest
 * listed them. `*` is one of the entries and is checked like any other, so
 * every conversation is a thing the user ticks rather than a default. */
function Scope({
  legend,
  empty,
  missing,
  offered,
  chosen,
  nameOf = (value) => value,
  onToggle,
  onName,
  pending = "",
  onPending,
}: {
  legend: string;
  empty: string;
  missing: string;
  offered: readonly string[];
  chosen: readonly string[];
  nameOf?: (value: string) => string;
  onToggle: (value: string) => void;
  /** Given when the manifest asked for every conversation, so the user can
   * hand over one instead of all of them. */
  onName?: ((value: string) => void) | undefined;
  pending?: string;
  onPending?: (value: string) => void;
}) {
  return (
    // Indented past the checkbox it belongs to: 14px of box and the 8px gap.
    <fieldset className="ml-[22px] flex flex-col gap-1.5 border-l border-[var(--border-subtle)] pl-3">
      <legend className="text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase">
        {legend}
      </legend>
      {offered.length === 0 && onName === undefined ? (
        <Note>{empty}</Note>
      ) : (
        <>
          {offered.map((value) => (
            <CheckField
              key={value}
              label={nameOf(value)}
              checked={chosen.includes(value)}
              onChange={() => onToggle(value)}
            />
          ))}
          {onName && onPending && (
            <NameOne
              legend={legend}
              onName={onName}
              typed={pending}
              onTyped={onPending}
            />
          )}
          {chosen.length === 0 && <Note>{missing}</Note>}
        </>
      )}
    </fieldset>
  );
}

/**
 * Naming one conversation instead of taking every one.
 *
 * Enter has to be caught here. A lone text input inside a form submits it,
 * which would save the grant without the channel that was just typed — and
 * marking the Add button `type="button"` does nothing about that, because the
 * submission comes from the input rather than from any button.
 */
function NameOne({
  legend,
  onName,
  typed,
  onTyped,
}: {
  legend: string;
  onName: (value: string) => void;
  typed: string;
  onTyped: (value: string) => void;
}) {
  const add = () => {
    const channel = typed.trim();
    if (channel === "" || channel === EVERY_CONVERSATION) return;
    onName(channel);
    onTyped("");
  };

  return (
    <div className="flex items-end gap-2">
      <div
        className="min-w-0 flex-1"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
      >
        <TextField
          label="Name one instead"
          value={typed}
          onChange={onTyped}
          placeholder="#channel or nick"
          hint={
            typed.trim() === ""
              ? `${legend} you name here are the only ones it reaches.`
              : `Add ${typed.trim()} or clear it — it is not granted until you do.`
          }
        />
      </div>
      <SecondaryButton onClick={add}>Add</SecondaryButton>
    </div>
  );
}

/** The backend's wording, or the manifest's own name for the permission if it
 * sent none — inventing a plain-terms line here would put the wording in two
 * places, and only one of them is enforced. */
function summaryOf(
  summaries: readonly PluginPermissionInfo[],
  permission: PluginPermission,
): string {
  return summaries.find((entry) => entry.permission === permission)?.summary ?? permission;
}
