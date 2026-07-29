import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Member } from "@/types";
import { MemberRow } from "./MemberRow";
import { SearchIcon } from "./icons";
import { GROUP_LABEL, filterMembers, groupMembers, toRows } from "./members";

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 26;

interface MemberListProps {
  members: Member[];
  selected: string | null;
  onSelect: (nick: string) => void;
}

export function MemberList({ members, selected, onSelect }: MemberListProps) {
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => toRows(groupMembers(filterMembers(members, query))),
    [members, query],
  );

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-2 py-2">
        <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[var(--text-muted)]">
          <SearchIcon />
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members"
          aria-label="Filter members"
          className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] py-1 pr-2 pl-7 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {rows.length === 0 ? (
          <p className="px-2 py-4 text-[var(--text-muted)]">
            {query ? `No member matches "${query}"` : "No members"}
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
                    <h3 className="flex items-end gap-1.5 px-2 pt-2 text-[11px] tracking-wide text-[var(--text-muted)] uppercase">
                      {GROUP_LABEL[row.group]}
                      <span className="text-[var(--text-faint)] normal-case">
                        — {row.count}
                      </span>
                    </h3>
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
    </div>
  );
}
