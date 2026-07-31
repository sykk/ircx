import { useState } from "react";
import type { Annotation, ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { nickColor } from "@/lib/nickColor";
import { serverMsgid } from "@/store";
import { isHighlight } from "@/store/selectors";
import { AttachmentLine } from "./AttachmentLine";
import { Markdown } from "./Markdown";
import { Reactions, RowControls } from "./Reactions";
import { ReplyQuote } from "./ReplyQuote";

interface MessageRowProps {
  message: ChatMessage;
  /** True when the message above this one in the block already quoted the same
   * parent. A reply too long for the wire is split into several messages, each
   * tagged with `+reply` because each has to stand on its own for everybody
   * else; drawing the quote again under it only splits one paragraph in two.
   * #138. */
  quotedAbove: boolean;
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

export function MessageRow({
  message,
  quotedAbove,
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
      className="group text-[13px]"
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
      {message.replyTo && !quotedAbove && (
        <div style={{ maxWidth: "var(--timeline-measure)" }}>
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
          gridTemplateColumns: "minmax(0, var(--timeline-measure)) var(--timeline-actions-col)",
          columnGap: "var(--timeline-actions-gap)",
        }}
      >
        <div>
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
          />

          {(message.annotations ?? []).map((note) => (
            <AnnotationLine key={note.plugin} note={note} />
          ))}

          {failed && <FailureNotice message={message} />}
        </div>

        {/* Their own column rather than laid over the far end of the measure.
            Reserving the room costs it whether or not the pointer is here; a
            long line running underneath a control could not be clicked, which
            is worse than the space. */}
        <div className="flex justify-end">
          {msgid !== null && (
            <RowControls
              alone
              onReply={() => onReply(msgid)}
              onPick={
                (message.reactions ?? []).length === 0
                  ? (emoji) => onReact(msgid, emoji, true)
                  : null
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The links the backend already found when it built the attachments, so the
 * line and the attachment under it agree about where a URL ends. */
function urlsOf(message: ChatMessage): string[] {
  return message.attachments.map((attachment) => attachment.url);
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
        <Markdown text={message.text} urls={urlsOf(message)} />
      </span>
    );
  }

  return <Markdown text={message.text} urls={urlsOf(message)} />;
}

/**
 * A plugin's note about somebody else's message. Named with the plugin rather
 * than the sender, and set apart from the text, because the one thing it must
 * never do is read as part of what the person wrote — the standing constraint
 * that a plugin cannot change what somebody said would mean little if its note
 * looked like the message.
 */
function AnnotationLine({ note }: { note: Annotation }) {
  return (
    <div
      className="mt-0.5 flex items-baseline gap-1.5 font-[family-name:var(--font-ui)] text-[11px]"
      style={{ color: "var(--text-faint)" }}
    >
      <span className="shrink-0 font-[family-name:var(--font-mono)]">{note.plugin}</span>
      <span className="min-w-0">{note.text}</span>
    </div>
  );
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
