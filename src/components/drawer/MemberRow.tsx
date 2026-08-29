import type { Member } from "@/types";
import { nickColor } from "@/lib/nickColor";

interface MemberRowProps {
  member: Member;
  onSelect: (member: Member) => void;
  onMenu: (member: Member, x: number, y: number) => void;
}

export function MemberRow({ member, onSelect, onMenu }: MemberRowProps) {
  const away = member.away !== null;
  const awayReason = member.away === null || member.away === "" ? "away" : member.away;
  /** Without `multi-prefix` this is all the server sent; the rest is in the
   * inspector. */
  const sigil = member.prefixes[0];

  return (
    <div
      tabIndex={0}
      role="listitem"
      aria-label={member.nick}
      aria-haspopup="menu"
      data-member={member.nick}
      onClick={() => onSelect(member)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(member, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(member);
          return;
        }
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onMenu(member, rect.left + 8, rect.top + 8);
      }}
      title={away ? `Away: ${awayReason}` : undefined}
      className="flex h-full w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="w-3 shrink-0 font-mono text-[var(--text-muted)]"
      >
        {sigil ?? ""}
      </span>
      {/* The name is on the element that truncates rather than on the row,
       * which already carries the away reason and takes its accessible name
       * from this text — a title there would be read back as a description
       * repeating the name. A reader hovering a clipped nick gets the whole of
       * it; nothing else changes. #352.
       *
       * Whether it is clipped at all is decided by CSS: the column is a
       * `clamp(8rem, <widest>ch + 3.5rem, 13rem)` and only names past the
       * ceiling lose anything, which is not knowable here. So it is set for
       * every row rather than for the rows that need it. */}
      <span
        title={member.nick}
        className="truncate"
        style={{ color: nickColor(member.nick) }}
      >
        {member.nick}
      </span>
      {away && (
        <span
          aria-hidden
          className="ml-auto size-2 shrink-0 rounded-full border-[1.5px]"
          style={{ borderColor: nickColor(member.nick) }}
        />
      )}
    </div>
  );
}
