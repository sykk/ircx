import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Member } from "@/types";
import { MemberRow } from "./MemberRow";
import { GROUP_LABEL, filterMembers, groupMembers, toRows } from "./members";

const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 26;

interface MemberListProps {
  members: Member[];
  selected: string | null;
  onSelect: (nick: string) => void;
  /** What the roster is narrowed to, or "" for a filter open and still empty. */
  filter: string;
}

export function MemberList({ members, selected, onSelect, filter }: MemberListProps) {
  const [expandMembers, setExpandMembers] = useState(false);
  const rows = useMemo(() => {
    const narrowed = filterMembers(members, filter);
    // A filter that could not see past the tenth member would answer for the
    // ten it was given rather than for the channel, so `… and n more` is not
    // drawn over one. An empty filter is not narrowing anything and keeps it.
    return toRows(groupMembers(narrowed), expandMembers || filter !== "");
  }, [members, filter, expandMembers]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Nothing the virtualiser returns leaves this component, so the compiler
  // skipping it costs nothing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3">
      {rows.length === 0 ? (
        <p className="px-1 py-4 text-[var(--text-muted)]">
          {filter === "" ? "No members" : `Nobody matching ${filter}`}
        </p>
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                className="absolute top-0 left-0 w-full"
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "header" ? (
                  <h3 className="flex h-full items-end px-2 pb-1 font-[family-name:var(--font-ui)] text-[11px] tracking-wide whitespace-nowrap text-[var(--text-muted)] uppercase">
                    {GROUP_LABEL[row.group]} — {row.count}
                  </h3>
                ) : row.kind === "more" ? (
                  <button
                    type="button"
                    onClick={() => setExpandMembers(true)}
                    className="flex h-full w-full items-center px-2 text-left font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    … and {row.hidden} more
                  </button>
                ) : (
                  <MemberRow
                    member={row.member}
                    selected={row.member.nick === selected}
                    onSelect={onSelect}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
