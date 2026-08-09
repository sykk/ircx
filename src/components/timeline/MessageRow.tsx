import { useState } from "react";
import type { Annotation, ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { nickColor } from "@/lib/nickColor";
import { serverMsgid, useAppStore } from "@/store";
import { isHighlight } from "@/store/selectors";
import { AttachmentLine } from "./AttachmentLine";
import { Clock } from "./Clock";
import { bodyText } from "./groups";
import { Markdown, Mentioned } from "./Markdown";
import { Reactions, RowControls } from "./Reactions";
import { ReplyQuote } from "./ReplyQuote";
import { writesOwnNick, type FailureRun } from "./rows";

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
  present: ReadonlySet<string>;
  flashing: boolean;
  /** Null unless this message failed. The run it failed with, and whether this
   * is the row carrying the notice for it. */
  failure: FailureRun | null;
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
  present,
  flashing,
  failure,
}: MessageRowProps) {
  const highlight = isHighlight(message, ownNick, present);
  // A rule raised this line to the same loudness a mention has, so it is marked
  // the same way: the row tinted, and the reason said in the words for it.
  const raised = (message.raisedBy ?? []).length > 0;
  // A reaction and a reply both travel as a `+reply` naming a msgid. Until the
  // server has given this message one there is nothing to name it by, so it can
  // be answered by neither — which is the window between sending a line and its
  // echo arriving.
  const msgid = canTag ? serverMsgid(message) : null;

  return (
    <div
      data-msgid={message.id}
      data-highlight={highlight || undefined}
      data-ui="message-row"
      className="group text-[13px]"
      style={{
        paddingBlock: "var(--timeline-row-pad-y)",
        background: flashing
          ? "var(--surface-active)"
          : highlight || raised
            ? "var(--mention-bg)"
            : undefined,
        // The rule marking a mention is the block's spine, which the block
        // tints. A second one inset here sat a column away from it and said the
        // same thing twice.
        opacity: message.delivery.state === "pending" ? "var(--pending-opacity)" : undefined,
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
          {raised && <RaisedLine by={message.raisedBy ?? []} />}

          {/* Read when the reader arrives at this row rather than announced.
              A paste queues a hundred of these at once, and the composer says
              a queue formed; a row saying so for itself would bury the
              conversation to repeat what was already said. The fade carries it
              for anyone who can see the fade, and carried it alone until #339.
              A span rather than an aria-label, which a generic element is not
              reliably given one from. */}
          {message.delivery.state === "pending" && (
            <span className="sr-only">Waiting to send</span>
          )}

          {/* Prose gets the text face; code and identifiers keep monospace. */}
          <div
            className="selectable font-[family-name:var(--font-ui)]"
            style={{ lineHeight: "var(--timeline-body-leading)" }}
          >
            <SenderPrefix message={message} />
            <Body message={message} mention={highlight ? ownNick : null} />
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

          {/* One notice for the run rather than one for each of its lines:
              the reason belongs to the connection, not to the message, and a
              cut mid-paste failed 78 of them at once. Every other row of the
              run says so in the column the reply controls would have used,
              which a failed message never has. #341. */}
          {failure?.last && <FailureNotice message={message} run={failure.run} />}
        </div>

        {/* Their own column rather than laid over the far end of the measure.
            Reserving the room costs it whether or not the pointer is here; a
            long line running underneath a control could not be clicked, which
            is worse than the space. */}
        <div className="flex justify-end">
          {failure && !failure.last && (
            <span
              className="font-[family-name:var(--font-ui)] text-[11px]"
              style={{ color: "var(--danger)" }}
            >
              Not sent
            </span>
          )}
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

/**
 * Who said it and when, in front of the line, for a reader who asked for the
 * name on each of them rather than once above the run.
 *
 * It sits in the flow of the prose and not in a column of its own. A column is
 * what the head of a run replaced: sized to the widest name in the block, it
 * moved the left edge of the prose every time a longer name spoke. Inline, a
 * second line of the same message wraps under the first word rather than under
 * the name, which is the cost of printing the name on every line and is what
 * the reader asked for.
 *
 * An action and a notice are skipped: both write their own nick into the body,
 * so a prefix would name the sender twice on one line.
 */
function SenderPrefix({ message }: { message: ChatMessage }) {
  const { clockSide, nickBrackets, nickEveryLine } = useAppStore((s) => s.presentation);
  if (!nickEveryLine || writesOwnNick(message.kind)) return null;

  const nick = message.sender.nick;
  return (
    /* Nowrap so the time and the name cannot be split from one another, and
       mono so the colon closing the prefix is set with the name it follows. */
    <span className="whitespace-nowrap font-[family-name:var(--font-mono)] text-[13px]">
      {clockSide === "left" && (
        <>
          <Clock at={message.timestamp} />{" "}
        </>
      )}
      <span className="font-semibold" style={{ color: nickColor(nick) }}>
        {nickBrackets ? `<${nick}>` : nick}
      </span>
      {clockSide === "right" && (
        <>
          {" "}
          <Clock at={message.timestamp} />
        </>
      )}
      {/* The brackets already close the name. Without them the colon is what
          separates it from what was said, in the form the reader wrote it in
          when they asked for this. A space rather than a margin, so a line
          copied out of the window reads as it does on the screen — the same
          reason an action writes one after its own nick. */}
      {nickBrackets ? " " : ": "}
    </span>
  );
}

/** The links the backend already found when it built the attachments, so the
 * line and the attachment under it agree about where a URL ends. */
function urlsOf(message: ChatMessage): string[] {
  return message.attachments.map((attachment) => attachment.url);
}

/** `mention` is the reader's nick only where this message is one; a line the
 * reader sent that happens to contain their own name is not addressed to
 * them, and isHighlight already says so. */
function Body({ message, mention }: { message: ChatMessage; mention: string | null }) {
  if (message.kind === "action") {
    return (
      <span>
        <span
          className="font-[family-name:var(--font-mono)]"
          style={{ color: nickColor(message.sender.nick) }}
        >
          * {message.sender.nick}{" "}
        </span>
        <Mentioned text={stripIrcFormatting(message.text)} mention={mention} />
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
        <Markdown text={message.text} urls={urlsOf(message)} mention={mention} />
      </span>
    );
  }

  // `bodyText` drops a bracket the sender typed to name a group, which the
  // block has already printed above the run. The archive keeps the raw text,
  // so search still matches what was written.
  return <Markdown text={bodyText(message)} urls={urlsOf(message)} mention={mention} />;
}

/**
 * Why this message made the conversation go loud, when it was not the reader's
 * own name that did it.
 *
 * Without it the badge is a mystery: a channel marked as loudly as a mention,
 * and nothing in it that mentions them. Named, because which rule thought so is
 * how a reader decides whether it should have — the same reason a note carries
 * the plugin that wrote it.
 *
 * Led by the verb rather than by the name, so it cannot be read as a note. A
 * note is the plugin's own words about a message; this is the client's words
 * about the plugin, and the two sit one above the other.
 */
function RaisedLine({ by }: { by: string[] }) {
  return (
    <div className="mb-0.5 font-[family-name:var(--font-ui)] text-[11px]">
      <span
        className="rounded-[var(--radius-sm)] px-1 font-semibold"
        style={{ background: "var(--accent-muted)", color: "var(--text-primary)" }}
      >
        raised by <span className="font-[family-name:var(--font-mono)]">{by.join(", ")}</span>
      </span>
    </div>
  );
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

function FailureNotice({ message, run }: { message: ChatMessage; run: ChatMessage[] }) {
  const [retrying, setRetrying] = useState(false);
  const detail = message.delivery.state === "failed" ? message.delivery.detail : "";

  // In the order they were said, and one at a time: they go back through the
  // same rate limiter that was draining them when the connection went, so
  // sending them together would only queue them together.
  const retry = async () => {
    setRetrying(true);
    try {
      for (const failed of run) {
        await ipc.submitInput(failed.network, failed.target, failed.text);
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      className="flex items-baseline gap-2 font-[family-name:var(--font-ui)] text-[11px]"
      style={{ color: "var(--danger)" }}
    >
      <span>
        {run.length === 1
          ? `Not sent — ${detail}`
          : `${run.length} messages were not sent — ${detail}`}
      </span>
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
