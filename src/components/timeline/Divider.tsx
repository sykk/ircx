import type { ReactNode } from "react";
import { describeDay, describeSpan, type Seam } from "./rows";

/**
 * A break across the pane. It carries its own room rather than borrowing the
 * block gap: a rule set as tightly as the messages either side reads as one
 * more row of conversation, which is the one thing it is not.
 */
function Rule({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-3"
      style={{
        paddingInline: "var(--timeline-rail-pad)",
        paddingBlock: "var(--timeline-rule-gap)",
      }}
      role="separator"
    >
      <span
        aria-hidden
        className="flex-1 border-t border-dotted"
        style={{ borderColor: tint }}
      />
      <span className="text-[11px] font-medium" style={{ color: tint }}>
        {children}
      </span>
      <span
        aria-hidden
        className="flex-1 border-t border-dotted"
        style={{ borderColor: tint }}
      />
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

/**
 * Where the server's own record of a conversation starts and stops.
 *
 * In the date rule's grey rather than the unread seam's colour: this is a fact
 * about where the words came from, not something the reader has to act on. What
 * it buys is that a service replaying somebody's comings and goings as ordinary
 * messages reads as a transcript rather than as a person in the room. #221.
 */
export function HistoryDivider({ opens }: { opens: boolean }) {
  return (
    <Rule tint="var(--text-faint)">
      {opens ? "From the server's history" : "Live from here"}
    </Rule>
  );
}

/**
 * Where a window opened by a search jump stops and the present resumes. #618.
 *
 * In the date rule's grey for the reason the history rule is: it is a fact
 * about what the pane is holding, and the thing to act on is the pill below it
 * rather than the rule. What it says is not how much is missing — the client
 * does not know, having never asked — only that the two messages it sits
 * between are not each other's neighbours.
 */
export function GapDivider() {
  return <Rule tint="var(--text-faint)">Messages in between are not shown</Rule>;
}

/** The size of what is about to be read is the part a skim cannot recover. */
export function UnreadDivider({ seam }: { seam: Seam }) {
  return (
    <Rule tint="var(--divider-unread)">
      {seam.messages === 0 ? "New messages" : clauses(seam)}
    </Rule>
  );
}
