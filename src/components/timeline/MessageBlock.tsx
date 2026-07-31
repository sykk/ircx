import type { ReactNode } from "react";
import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";
import { MessageRow } from "./MessageRow";
import { formatClock, writesOwnNick } from "./rows";

const LADDER = "var(--timeline-spine-width) var(--timeline-spine-gap) minmax(0, 1fr)";

interface BlockProps {
  spine: boolean;
  children: ReactNode;
}

/**
 * The ladder every row hangs from: a spine, then the content column. Speech and
 * presence share it, so one left edge runs the length of the pane whatever any
 * given block turns out to contain.
 *
 * The clock used to open the ladder in a column of its own. It cost 120px
 * before the first word and printed only when the minute changed, so most rows
 * paid for it and left it empty. It is in the block header now.
 */
export function Block({ spine, children }: BlockProps) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: LADDER,
        paddingLeft: "var(--timeline-rail-pad)",
        paddingRight: "16px",
        paddingTop: "var(--timeline-block-gap)",
      }}
    >
      {spine && (
        <div style={{ gridColumn: 1, background: "var(--border-strong)" }} aria-hidden="true" />
      )}
      <div style={{ gridColumn: 3 }}>{children}</div>
    </div>
  );
}

/** The time a block began, set in the same face and size wherever it appears. */
export function Clock({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
      style={{ color: "var(--text-faint)" }}
    >
      {formatClock(at)}
    </time>
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
 */
function repeatsQuote(messages: ChatMessage[], at: number): boolean {
  const above = messages[at - 1];
  const message = messages[at]!;
  return above !== undefined && message.replyTo !== null && message.replyTo === above.replyTo;
}

/**
 * One run of one person's lines: their name and the time stated once above it,
 * and every line beneath starting at the same left edge as the name.
 *
 * The nickname used to be printed beside every line, in a column sized to the
 * widest name the block held. Because a block was a minute, that column changed
 * width from one minute to the next and took the prose with it: five different
 * left edges on one screen of #libera-dev. The name is still written out in
 * full, being the identifier colour only reinforces — once, at the head.
 */
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
  const head = messages[0]!;

  return (
    <Block spine>
      {/* An action or a notice writes its own nick into the body, so a header
          would say the name the first line is about to say again. */}
      {!writesOwnNick(head.kind) && (
        <div className="flex items-baseline gap-2">
          <span
            className="font-[family-name:var(--font-mono)] text-[13px] font-semibold"
            style={{ color: nickColor(head.sender.nick) }}
          >
            {head.sender.nick}
          </span>
          <Clock at={head.timestamp} />
        </div>
      )}
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
