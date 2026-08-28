import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { nickColor } from "@/lib/nickColor";
import { useAppStore } from "@/store";
import { sameTarget, splitTargetKey, type TargetKey } from "@/store/keys";
import type { Member } from "@/types";
import { BackIcon } from "./icons";

/** Shared so an absent lookup returns one stable reference. */
const NOBODY: string[] = [];

interface UserInspectorProps {
  network: string;
  member: Member;
  onBack: () => void;
}

export function UserInspector({
  network,
  member,
  onBack,
}: UserInspectorProps) {
  const membersByTarget = useAppStore((s) => s.members);
  const ignored = useAppStore((s) => s.ignored[network] ?? NOBODY);
  const isIgnored = ignored.some((nick) => sameTarget(nick, member.nick));
  const [failed, setFailed] = useState<string | null>(null);

  // Through the store rather than through `/ignore`: the inspector is not a
  // conversation, and a command needs one to be typed in.
  const toggle = useCallback(async () => {
    setFailed(null);
    try {
      await ipc.setIgnored(network, member.nick, !isIgnored);
    } catch (reason) {
      setFailed(typeof reason === "string" ? reason : "That could not be changed.");
    }
  }, [network, member.nick, isIgnored]);

  // What the `WHO` a join sends could not answer. That reply carries a real
  // name on every server and an account only where the server has `WHOX`, so
  // either blank is a reason to ask and neither is proof the other arrived.
  // The session sends at most one question per person, so opening this panel
  // again is not another. Failures are silent — a panel that could not ask
  // shows the blank it already had.
  useEffect(() => {
    if (member.realname !== null && member.account !== null) return;
    void ipc.lookUpMember(network, member.nick).catch(() => {});
  }, [network, member.nick, member.realname, member.account]);

  const shared = useMemo(() => {
    const channels: string[] = [];
    for (const [key, list] of Object.entries(membersByTarget)) {
      const owner = splitTargetKey(key as TargetKey);
      if (owner.network !== network) continue;
      if (list.some((m) => sameTarget(m.nick, member.nick))) channels.push(owner.target);
    }
    return channels.sort((a, b) => a.localeCompare(b));
  }, [membersByTarget, network, member.nick]);

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
        <dt className="text-[var(--text-muted)]">Real name</dt>
        <dd className="selectable truncate text-[var(--text-primary)]">
          {member.realname ?? <span className="text-[var(--text-muted)]">not known</span>}
        </dd>
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
        {/* Said rather than only offered: an inspector that did not name the
            ignore would leave the reader looking at a person whose messages
            are missing for no reason the window gives. */}
        {isIgnored && (
          <p className="pb-2 text-[var(--text-secondary)]">
            You are ignoring {member.nick}. Nothing they say is kept.
          </p>
        )}
        <button
          type="button"
          onClick={() => void toggle()}
          className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          {isIgnored ? "Stop ignoring" : "Ignore"}
        </button>
        {failed !== null && (
          <p role="alert" className="pt-1 text-[var(--danger)]">
            {failed}
          </p>
        )}
      </div>

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

    </div>
  );
}
