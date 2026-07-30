import type { CSSProperties, ReactNode } from "react";
import type { ChatMessage } from "@/types";
import { MessageRow } from "./MessageRow";
import { formatClock, nickColumnCh } from "./rows";

const LADDER =
  "var(--clock-col) var(--spine-gap) var(--spine-w) var(--nick-gap) minmax(0, 1fr)";

interface BlockProps {
  /** The block's own time, printed once in the gutter. */
  at: string;
  spine: boolean;
  /** Width of the nick column, in monospace characters. */
  nickCh?: number;
  children: ReactNode;
}

/**
 * The ladder every row hangs from: a right-aligned clock, a spine, then the
 * content column. Speech and presence share it so their left edges line up
 * whatever either one contains.
 */
export function Block({ at, spine, nickCh, children }: BlockProps) {
  return (
    <div
      className="grid"
      style={
        {
          gridTemplateColumns: LADDER,
          paddingLeft: "var(--rail-pad)",
          paddingRight: "16px",
          paddingTop: "var(--block-gap)",
          ...(nickCh === undefined ? null : { "--nick-col": `${nickCh}ch` }),
        } as CSSProperties
      }
    >
      <time
        dateTime={at}
        className="self-start text-right font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
        style={{ color: "var(--text-faint)", lineHeight: "calc(13px * var(--body-leading))" }}
      >
        {formatClock(at)}
      </time>
      {spine && (
        <div style={{ gridColumn: 3, background: "var(--border-strong)" }} aria-hidden="true" />
      )}
      <div style={{ gridColumn: 5 }}>{children}</div>
    </div>
  );
}

interface Props {
  messages: ChatMessage[];
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  flashId: string | null;
}

/** One minute of the conversation, however many people spoke during it. */
export function MessageBlock({ messages, ownNick, parentOf, onJump, flashId }: Props) {
  return (
    <Block at={messages[0]!.timestamp} spine nickCh={nickColumnCh(messages)}>
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          ownNick={ownNick}
          parentOf={parentOf}
          onJump={onJump}
          flashing={message.id === flashId}
        />
      ))}
    </Block>
  );
}
