import type { CSSProperties, ReactNode } from "react";
import type { ChatMessage } from "@/types";
import { MessageRow } from "./MessageRow";
import { formatClock, nickColumnCh } from "./rows";

const LADDER =
  "var(--timeline-clock-col) var(--timeline-spine-gap) var(--timeline-spine-width) var(--timeline-nick-gap) minmax(0, 1fr)";

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
          paddingLeft: "var(--timeline-rail-pad)",
          paddingRight: "16px",
          paddingTop: "var(--timeline-block-gap)",
          ...(nickCh === undefined ? null : { "--nick-col": `${nickCh}ch` }),
        } as CSSProperties
      }
    >
      <time
        dateTime={at}
        className="self-start text-right font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
        style={{
          color: "var(--text-faint)",
          lineHeight: "calc(13px * var(--timeline-body-leading))",
        }}
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
  canTag: boolean;
  onReact: (msgid: string, emoji: string, active: boolean) => void;
  onReply: (msgid: string) => void;
  flashId: string | null;
}

/**
 * Whether the message above this one already quoted the same parent, and so
 * said what this one is answering.
 *
 * A block is a minute rather than a run of one person's lines, so the sender
 * has to match too: two people answering the same message each need their own
 * quote, or the second reads as a continuation of the first.
 */
function repeatsQuote(messages: ChatMessage[], at: number): boolean {
  const above = messages[at - 1];
  const message = messages[at]!;
  return (
    above !== undefined &&
    message.replyTo !== null &&
    message.replyTo === above.replyTo &&
    message.sender.nick === above.sender.nick
  );
}

/** One minute of the conversation, however many people spoke during it. */
export function MessageBlock({
  messages,
  ownNick,
  parentOf,
  onJump,
  canTag,
  onReact,
  onReply,
  flashId,
}: Props) {
  return (
    <Block at={messages[0]!.timestamp} spine nickCh={nickColumnCh(messages)}>
      {messages.map((message, at) => (
        <MessageRow
          key={message.id}
          message={message}
          quotedAbove={repeatsQuote(messages, at)}
          ownNick={ownNick}
          parentOf={parentOf}
          onJump={onJump}
          canTag={canTag}
          onReact={onReact}
          onReply={onReply}
          flashing={message.id === flashId}
        />
      ))}
    </Block>
  );
}
