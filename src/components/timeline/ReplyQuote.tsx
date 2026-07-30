import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";

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
const CONNECTOR = "2px solid var(--border-strong)";

export function ReplyQuote({ msgid, parent, onJump }: Props) {
  if (!parent) {
    return (
      <div
        className="truncate pl-2 font-[family-name:var(--font-ui)] text-[12px]"
        style={{ borderLeft: CONNECTOR, color: "var(--text-faint)" }}
      >
        in reply to {msgid}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onJump(msgid)}
      title={parent.text}
      className="flex w-full items-baseline gap-1.5 overflow-hidden pl-2 text-left font-[family-name:var(--font-ui)] text-[12px]"
      style={{ borderLeft: CONNECTOR, color: "var(--text-faint)" }}
    >
      <span
        className="shrink-0 font-[family-name:var(--font-mono)]"
        style={{ color: nickColor(parent.sender.nick) }}
      >
        {parent.sender.nick}
      </span>
      <span aria-hidden="true" className="shrink-0">
        —
      </span>
      <span className="truncate">{parent.text}</span>
    </button>
  );
}
