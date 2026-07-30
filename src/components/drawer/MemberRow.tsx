import type { Member } from "@/types";
import { nickColor } from "@/lib/nickColor";

interface MemberRowProps {
  member: Member;
  selected: boolean;
  onSelect: (nick: string) => void;
}

export function MemberRow({ member, selected, onSelect }: MemberRowProps) {
  const away = member.away !== null;
  const awayReason = member.away === null || member.away === "" ? "away" : member.away;
  /** Without `multi-prefix` this is all the server sent; the rest is in the
   * inspector. */
  const sigil = member.prefixes[0];

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
        style={{ background: nickColor(member.nick) }}
      />
      <span
        className={`truncate ${away ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}
      >
        {member.nick}
      </span>
      {sigil !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-[var(--text-muted)]">
          {sigil}
        </span>
      )}
    </button>
  );
}
