import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";
import { MessageRow } from "./MessageRow";
import { formatClock } from "./rows";

interface Props {
  messages: ChatMessage[];
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  flashId: string | null;
}

export function MessageGroup({ messages, ownNick, parentOf, onJump, flashId }: Props) {
  const first = messages[0]!;
  // An action already reads `* nick text` and a notice `-nick- text`; a heading
  // above either would print the nick twice.
  const headed = first.kind !== "action" && first.kind !== "notice";

  return (
    <div style={{ paddingTop: "var(--block-gap)" }}>
      {headed && (
        <div className="flex items-baseline gap-2 px-4 font-[family-name:var(--font-mono)]">
          {/* The nickname is the identifier; colour only reinforces it, so the
              name is written out in full on every block header. */}
          <span className="text-[12.5px] font-semibold" style={{ color: nickColor(first.sender.nick) }}>
            {first.sender.nick}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--text-faint)" }}>
            {formatClock(first.timestamp)}
          </span>
        </div>
      )}
      {messages.map((message, i) => (
        <MessageRow
          key={message.id}
          message={message}
          ownNick={ownNick}
          clock={!headed ? "always" : i === 0 ? "none" : "hover"}
          parentOf={parentOf}
          onJump={onJump}
          flashing={message.id === flashId}
        />
      ))}
    </div>
  );
}
