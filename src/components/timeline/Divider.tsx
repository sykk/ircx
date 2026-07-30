import type { ReactNode } from "react";
import { describeDay, describeSpan, type Seam } from "./rows";

function Rule({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 py-2"
      style={{ paddingInline: "var(--timeline-rail-pad)" }}
      role="separator"
    >
      <span className="h-px flex-1" style={{ background: tint }} />
      <span className="text-[11px] font-medium" style={{ color: tint }}>
        {children}
      </span>
      <span className="h-px flex-1" style={{ background: tint }} />
    </div>
  );
}

export function DateSeparator({ at }: { at: string }) {
  return <Rule tint="var(--text-faint)">{describeDay(at)}</Rule>;
}

function clauses(seam: Seam): string {
  const size = [
    `${seam.messages} message${seam.messages === 1 ? "" : "s"}`,
    `${seam.people} ${seam.people === 1 ? "person" : "people"}`,
    describeSpan(seam.spanMs),
  ].join(", ");
  if (seam.mentions === 0) return size;
  return `${size} · ${seam.mentions} of them mention${seam.mentions === 1 ? "s" : ""} you`;
}

/** The size of what is about to be read is the part a skim cannot recover. */
export function UnreadDivider({ seam }: { seam: Seam }) {
  return (
    <Rule tint="var(--divider-unread)">
      {seam.messages === 0 ? "New messages" : clauses(seam)}
    </Rule>
  );
}
