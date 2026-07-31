import { useState } from "react";
import type { ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { nickColor } from "@/lib/nickColor";
import { serverMsgid } from "@/store";
import { isHighlight } from "@/store/selectors";
import { AttachmentLine } from "./AttachmentLine";
import { Markdown } from "./Markdown";
import { Reactions } from "./Reactions";
import { ReplyQuote } from "./ReplyQuote";
import { writesOwnNick } from "./rows";

interface MessageRowProps {
  message: ChatMessage;
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  /** False on a server without `message-tags`. Both reacting and replying put
   * a client tag on the wire, so without it there is nothing to offer. */
  canTag: boolean;
  onReact: (msgid: string, emoji: string, active: boolean) => void;
  onReply: (msgid: string) => void;
  flashing: boolean;
}

/** Indent that puts anything without a nick under the text column. */
const TEXT_INDENT = "calc(var(--nick-col) + var(--timeline-text-gap))";

export function MessageRow({
  message,
  ownNick,
  parentOf,
  onJump,
  canTag,
  onReact,
  onReply,
  flashing,
}: MessageRowProps) {
  const highlight = isHighlight(message, ownNick);
  const failed = message.delivery.state === "failed";
  // A reaction and a reply both travel as a `+reply` naming a msgid. Until the
  // server has given this message one there is nothing to name it by, so it can
  // be answered by neither — which is the window between sending a line and its
  // echo arriving.
  const msgid = canTag ? serverMsgid(message) : null;

  return (
    <div
      data-msgid={message.id}
      data-highlight={highlight || undefined}
      // Monospace here so `--nick-col`, which is stated in `ch`, resolves
      // against the face the nick is actually set in.
      className="group font-[family-name:var(--font-mono)] text-[13px]"
      style={{
        paddingBlock: "var(--timeline-row-pad-y)",
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
        <div style={{ marginLeft: TEXT_INDENT, maxWidth: "var(--timeline-measure)" }}>
          <ReplyQuote
            msgid={message.replyTo}
            parent={parentOf(message.replyTo)}
            onJump={onJump}
          />
        </div>
      )}

      <div
        className="grid items-baseline"
        style={{
          gridTemplateColumns: "var(--nick-col) minmax(0, var(--timeline-measure))",
          columnGap: "var(--timeline-text-gap)",
        }}
      >
        {/* The nickname is the identifier; colour only reinforces it, so the
            name is written out in full beside every line its author sent. */}
        <span className="font-semibold" style={{ color: nickColor(message.sender.nick) }}>
          {writesOwnNick(message.kind) ? "" : message.sender.nick}
        </span>

        {/* Relative so the hover-only add control can sit at the far end of the
            measure without taking room from the message. */}
        <div className="relative">
          {/* Prose gets the text face; code and identifiers keep monospace. */}
          <div
            className="selectable font-[family-name:var(--font-ui)]"
            style={{ lineHeight: "var(--timeline-body-leading)" }}
          >
            <Body message={message} />
          </div>

          {message.attachments.map((attachment) => (
            <AttachmentLine key={attachment.url} attachment={attachment} />
          ))}

          <Reactions
            reactions={message.reactions ?? []}
            ownNick={ownNick}
            onToggle={
              msgid === null
                ? null
                : (emoji, active) => onReact(msgid, emoji, active)
            }
            onReply={msgid === null ? null : () => onReply(msgid)}
          />

          {failed && <FailureNotice message={message} />}
        </div>
      </div>
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
        {stripIrcFormatting(message.text)}
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
    <div
      className="flex items-baseline gap-2 font-[family-name:var(--font-ui)] text-[11px]"
      style={{ color: "var(--danger)" }}
    >
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
