import type { Member } from "@/types";
import { nickColour } from "./members";

interface MemberRowProps {
  member: Member;
  selected: boolean;
  onSelect: (nick: string) => void;
}

export function MemberRow({ member, selected, onSelect }: MemberRowProps) {
  const away = member.away !== null;
  const awayReason = member.away === null || member.away === "" ? "away" : member.away;

  return (
    <button
      type="button"
      onClick={() => onSelect(member.nick)}
      title={away ? `Away: ${awayReason}` : undefined}
      aria-pressed={selected}
      className={`flex h-full w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left ${
        selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"
      }`}
    >
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${away ? "opacity-40" : ""}`}
        style={{ background: nickColour(member.nick) }}
      />
      {member.prefixes.length > 0 && (
        <span className="font-mono text-[11px] text-[var(--text-muted)]">
          {member.prefixes.join("")}
        </span>
      )}
      <span
        className={`truncate ${away ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}
      >
        {member.nick}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {member.account !== null && (
          <span
            title={`Identified to services as ${member.account}`}
            className="max-w-24 truncate rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-1.5 py-px text-[10px] text-[var(--badge-text)]"
          >
            {member.account.toLowerCase() === member.nick.toLowerCase()
              ? "account"
              : member.account}
          </span>
        )}
        {away && (
          <span className="max-w-24 truncate rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-1.5 py-px text-[10px] text-[var(--warning)]">
            {awayReason}
          </span>
        )}
      </span>
    </button>
  );
}
