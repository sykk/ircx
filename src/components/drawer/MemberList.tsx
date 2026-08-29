import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Member } from "@/types";
import { MemberRow } from "./MemberRow";
import { GROUP_LABEL, filterMembers, groupMembers, toRows } from "./members";

const HEADER_HEIGHT = 34;
const MEMBERS_HEADER_HEIGHT = 44;
const ROW_HEIGHT = 26;

interface MemberListProps {
  members: Member[];
  recentNicks?: readonly string[];
  onSelect: (member: Member) => void;
  onMenu: (member: Member, x: number, y: number) => void;
  /** What the roster is narrowed to, or "" for a filter open and still empty. */
  filter: string;
}

export function MemberList({
  members,
  recentNicks = [],
  onSelect,
  onMenu,
  filter,
}: MemberListProps) {
  const [expandMembers, setExpandMembers] = useState(false);
  const [order, setOrder] = useState<"recent" | "alphabetical">("recent");
  const rows = useMemo(() => {
    const narrowed = filterMembers(members, filter);
    // A filter that could not see past the tenth member would answer for the
    // ten it was given rather than for the channel, so `… and n more` is not
    // drawn over one. An empty filter is not narrowing anything and keeps it.
    return toRows(
      groupMembers(narrowed, order === "recent" ? recentNicks : undefined),
      expandMembers || filter !== "",
    );
  }, [members, recentNicks, filter, expandMembers, order]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Nothing the virtualiser returns leaves this component, so the compiler
  // skipping it costs nothing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index]?.kind === "header"
        ? rows[index].group === "members"
          ? MEMBERS_HEADER_HEIGHT
          : HEADER_HEIGHT
        : ROW_HEIGHT,
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
                  <div
                    className={`flex h-full px-2 pb-1 font-[family-name:var(--font-ui)] text-[11px] whitespace-nowrap text-[var(--text-muted)] ${
                      row.group === "members"
                        ? "flex-col items-start justify-end gap-0.5"
                        : "items-end"
                    }`}
                  >
                    <h3 className="tracking-wide uppercase">
                      {GROUP_LABEL[row.group]} — {row.count}
                    </h3>
                    {row.group === "members" && (
                      <span className="flex items-center gap-1 text-[10px] tracking-normal normal-case">
                        <button
                          type="button"
                          aria-pressed={order === "recent"}
                          onClick={() => setOrder("recent")}
                          className={
                            order === "recent"
                              ? "text-[var(--text-primary)]"
                              : "hover:text-[var(--text-primary)]"
                          }
                        >
                          recent
                        </button>
                        <span aria-hidden className="text-[var(--text-faint)]">·</span>
                        <button
                          type="button"
                          aria-label="Sort members A to Z"
                          aria-pressed={order === "alphabetical"}
                          onClick={() => setOrder("alphabetical")}
                          className={
                            order === "alphabetical"
                              ? "text-[var(--text-primary)]"
                              : "hover:text-[var(--text-primary)]"
                          }
                        >
                          a–z
                        </button>
                      </span>
                    )}
                  </div>
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
                    onSelect={onSelect}
                    onMenu={onMenu}
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
