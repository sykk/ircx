import { describeSpan, type Seam } from "./rows";

function clauses(seam: Seam): string {
  const size = [
    `${seam.messages} message${seam.messages === 1 ? "" : "s"}`,
    `${seam.people} ${seam.people === 1 ? "person" : "people"}`,
    describeSpan(seam.spanMs),
  ].join(", ");
  if (seam.mentions === 0) return size;
  return `${size} · ${seam.mentions} mention${seam.mentions === 1 ? "s" : ""} you`;
}

/** The size of what is about to be read is the part a skim cannot recover. */
export function UnreadDivider({ seam }: { seam: Seam }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2" role="separator">
      <span className="h-px flex-1" style={{ background: "var(--divider-unread)" }} />
      <span className="text-[11px] font-medium" style={{ color: "var(--divider-unread)" }}>
        {seam.messages === 0 ? "New messages" : clauses(seam)}
      </span>
      <span className="h-px flex-1" style={{ background: "var(--divider-unread)" }} />
    </div>
  );
}
