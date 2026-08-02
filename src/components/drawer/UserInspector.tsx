import { useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { nickColor } from "@/lib/nickColor";
import { useAppStore } from "@/store";
import { sameTarget, splitTargetKey, type TargetKey } from "@/store/keys";
import type { Member } from "@/types";
import { BackIcon } from "./icons";
import { actionsFor, rankOf } from "./members";

interface UserInspectorProps {
  network: string;
  channel: string;
  member: Member;
  /** The local user's entry in this channel, absent until NAMES lands. */
  self: Member | undefined;
  onBack: () => void;
}

export function UserInspector({
  network,
  channel,
  member,
  self,
  onBack,
}: UserInspectorProps) {
  const [error, setError] = useState<string | null>(null);
  const membersByTarget = useAppStore((s) => s.members);

  const shared = useMemo(() => {
    const channels: string[] = [];
    for (const [key, list] of Object.entries(membersByTarget)) {
      const owner = splitTargetKey(key as TargetKey);
      if (owner.network !== network) continue;
      if (list.some((m) => sameTarget(m.nick, member.nick))) channels.push(owner.target);
    }
    return channels.sort((a, b) => a.localeCompare(b));
  }, [membersByTarget, network, member.nick]);

  const allowed = actionsFor(self);
  const isOp = rankOf(member) >= 3;
  const isVoiced = member.prefixes.includes("+");

  async function run(input: string) {
    setError(null);
    try {
      const outcome = await ipc.submitInput(network, channel, input);
      if (outcome.kind === "rejected") setError(outcome.value);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The command could not be sent.");
    }
  }

  async function openQuery() {
    setError(null);
    try {
      await ipc.openQuery(network, member.nick);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The query could not be opened.");
    }
  }

  // The column carries the mono family so its width can be counted in `ch`. The
  // inspector is prose and fields rather than a list of names.
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto font-[family-name:var(--font-ui)]">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 px-2 py-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <BackIcon />
        Members
      </button>

      <div className="flex items-center gap-2 px-3 pb-3">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: nickColor(member.nick) }}
        />
        <h3 className="truncate text-[15px] text-[var(--text-primary)]">{member.nick}</h3>
        {member.prefixes.length > 0 && (
          <span className="font-mono text-[var(--text-muted)]">
            {member.prefixes.join("")}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-3">
        <dt className="text-[var(--text-muted)]">Account</dt>
        <dd className="selectable truncate text-[var(--text-primary)]">
          {member.account ?? (
            <span className="text-[var(--text-muted)]">not identified</span>
          )}
        </dd>
        <dt className="text-[var(--text-muted)]">Status</dt>
        <dd className="truncate text-[var(--text-primary)]">
          {member.away === null ? "here" : `away — ${member.away || "no reason given"}`}
        </dd>
      </dl>

      <div className="px-3 pb-3">
        <h4 className="pb-1 text-[11px] tracking-wide text-[var(--text-muted)] uppercase">
          Shared channels — {shared.length}
        </h4>
        <ul className="flex flex-wrap gap-1">
          {shared.map((name) => (
            <li
              key={name}
              className="rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-1.5 py-px text-[var(--badge-text)]"
            >
              {name}
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-1 border-t border-[var(--border-subtle)] px-2 py-2">
        <ActionButton label="Message" onClick={openQuery} />
        <ActionButton label="Whois" onClick={() => run(`/whois ${member.nick}`)} />
        <ActionButton
          label={isOp ? "Take ops" : "Give ops"}
          allowed={allowed.op}
          requires="operator status"
          onClick={() => run(`/mode ${channel} ${isOp ? "-o" : "+o"} ${member.nick}`)}
        />
        <ActionButton
          label={isVoiced ? "Take voice" : "Give voice"}
          allowed={allowed.voice}
          requires="halfop status or better"
          onClick={() => run(`/mode ${channel} ${isVoiced ? "-v" : "+v"} ${member.nick}`)}
        />
        <ActionButton
          label="Kick"
          danger
          allowed={allowed.kick}
          requires="halfop status or better"
          onClick={() => run(`/kick ${channel} ${member.nick}`)}
        />
        <ActionButton
          label="Ban"
          danger
          allowed={allowed.ban}
          requires="operator status"
          onClick={() => run(`/mode ${channel} +b ${member.nick}!*@*`)}
        />
      </div>

      {error !== null && (
        <p role="alert" className="px-3 pb-3 text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  allowed?: boolean;
  requires?: string;
  danger?: boolean;
}

function ActionButton({
  label,
  onClick,
  allowed = true,
  requires,
  danger = false,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={!allowed}
      onClick={onClick}
      title={allowed ? undefined : `Needs ${requires}`}
      className={`rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-1 disabled:cursor-not-allowed disabled:border-[var(--border-subtle)] disabled:text-[var(--text-faint)] disabled:hover:bg-transparent ${
        danger
          ? "text-[var(--danger)] hover:bg-[var(--surface-hover)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      }`}
    >
      {label}
    </button>
  );
}
