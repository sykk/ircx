import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";
import { useAppStore } from "@/store";
import { plainText } from "./Markdown";

interface Props {
  msgid: string;
  /** Undefined when the parent is outside the loaded window. */
  parent: ChatMessage | undefined;
  onJump: (msgid: string) => void;
}

/**
 * A `reply_to` is a fact the sender declared over the protocol, so the
 * connector is solid. Nothing here infers a strand; a guess would have to be
 * drawn differently from a fact, and this milestone makes no guesses.
 */
const CONNECTOR = "var(--timeline-quote-width) solid var(--border-strong)";

export function ReplyQuote({ msgid, parent, onJump }: Props) {
  const excerpt = parent ? plainText(parent.text) : "";
  const nickColors = useAppStore((s) => s.presentation.nickColors);

  // A msgid names the message on the wire and nothing the reader has ever seen,
  // so the quote says the one thing it can: that this answers something the
  // window does not hold. The connector still runs, the reply being a fact its
  // sender declared whether or not we can show what it answers.
  if (!parent) {
    return (
      <div
        className="truncate pl-2 font-[family-name:var(--font-ui)] text-[12px]"
        style={{ borderLeft: CONNECTOR, color: "var(--text-faint)" }}
      >
        in reply to an earlier message
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onJump(msgid)}
      title={excerpt}
      className="flex w-full items-baseline gap-1.5 overflow-hidden pl-2 text-left font-[family-name:var(--font-ui)] text-[12px]"
      style={{ borderLeft: CONNECTOR, color: "var(--text-faint)" }}
    >
      <span
        className="shrink-0 font-[family-name:var(--font-mono)]"
        style={{ color: nickColors ? nickColor(parent.sender.nick) : "var(--text-primary)" }}
      >
        {parent.sender.nick}
      </span>
      <span aria-hidden="true" className="shrink-0">
        —
      </span>
      <span className="truncate">{excerpt}</span>
    </button>
  );
}
