import { useState } from "react";
import type { ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { nickColor } from "@/lib/nickColor";
import { isHighlight } from "@/store/selectors";
import { AttachmentCard } from "./AttachmentCard";
import { Markdown } from "./Markdown";
import { ReplyQuote } from "./ReplyQuote";
import { formatClock } from "./rows";

interface MessageRowProps {
  message: ChatMessage;
  ownNick: string | null;
  /** `none` when a group heading already carries the time for this row. */
  clock: "always" | "hover" | "none";
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  flashing: boolean;
}

export function MessageRow({
  message,
  ownNick,
  clock,
  parentOf,
  onJump,
  flashing,
}: MessageRowProps) {
  const highlight = isHighlight(message, ownNick);
  const failed = message.delivery.state === "failed";

  return (
    <div
      data-msgid={message.id}
      data-highlight={highlight || undefined}
      className="group/row relative px-4"
      style={{
        paddingBlock: "var(--row-pad-y)",
        background: flashing
          ? "var(--surface-active)"
          : highlight
            ? "var(--mention-bg)"
            : undefined,
        boxShadow: highlight ? "inset 2px 0 0 var(--accent)" : undefined,
        opacity: message.delivery.state === "pending" ? 0.55 : undefined,
      }}
    >
      {message.replyTo && (
        <ReplyQuote
          msgid={message.replyTo}
          parent={parentOf(message.replyTo)}
          onJump={onJump}
        />
      )}

      {/* Prose gets the text face; code, clocks and identifiers keep monospace. */}
      <div className="selectable text-[13px]" style={{ lineHeight: "var(--body-leading)" }}>
        <Body message={message} />
      </div>

      {message.attachments.map((attachment) => (
        <AttachmentCard key={attachment.url} attachment={attachment} />
      ))}

      {failed && <FailureNotice message={message} />}

      {clock !== "none" && (
        <span
          className={
            "pointer-events-none absolute right-3 top-px font-[family-name:var(--font-mono)] text-[11px] tabular-nums" +
            (clock === "hover" ? " opacity-0 group-hover/row:opacity-100" : "")
          }
          style={{ color: "var(--text-faint)" }}
        >
          {formatClock(message.timestamp)}
        </span>
      )}
    </div>
  );
}

function Body({ message }: { message: ChatMessage }) {
  if (message.kind === "action") {
    return (
      <span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ color: nickColor(message.sender.nick) }}
        >
          * {message.sender.nick}{" "}
        </span>
        {message.text}
      </span>
    );
  }

  if (message.kind === "notice") {
    return (
      <span style={{ color: "var(--text-secondary)" }}>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ color: nickColor(message.sender.nick) }}
        >
          -{message.sender.nick}-{" "}
        </span>
        <Markdown text={message.text} />
      </span>
    );
  }

  return <Markdown text={message.text} />;
}

function FailureNotice({ message }: { message: ChatMessage }) {
  const [retrying, setRetrying] = useState(false);
  const detail = message.delivery.state === "failed" ? message.delivery.detail : "";

  const retry = async () => {
    setRetrying(true);
    try {
      await ipc.submitInput(message.network, message.target, message.text);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex items-baseline gap-2 text-[11px]" style={{ color: "var(--danger)" }}>
      <span>Not sent — {detail}</span>
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className="underline"
        style={{ color: "var(--accent)" }}
      >
        {retrying ? "Retrying" : "Retry"}
      </button>
    </div>
  );
}
