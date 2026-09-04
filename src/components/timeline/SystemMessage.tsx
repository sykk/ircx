import { useState } from "react";
import clsx from "clsx";
import type { ChatMessage, MessageKind } from "@/types";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { TransferControls } from "@/components/transfers/TransferControls";
import { useAppStore } from "@/store";
import { useTransferFor } from "@/store/selectors";
import { Clock } from "./Clock";
import { Block } from "./MessageBlock";
import {
  describePresenceSummary,
  describePresenceRun,
  describePresenceSpan,
  partitionSystemRun,
  presenceInvolving,
  summarizePresence,
} from "./rows";

/**
 * Backends that phrase the event themselves win; the fallback exists so a bare
 * `join` with no text still reads as a sentence rather than an empty row.
 */
function systemText(message: ChatMessage): string {
  // A mode says what happened and the row says who it happened to: core writes
  // `took ops` so the digest can count two of them as one clause, which leaves
  // the name to the only place that still holds it.
  if (message.kind === "mode" && message.text.trim() !== "") {
    return `${message.sender.nick} ${stripIrcFormatting(message.text)}`;
  }
  if (message.text.trim() !== "") return stripIrcFormatting(message.text);
  const nick = message.sender.nick;
  switch (message.kind) {
    case "join":
      return `${nick} joined`;
    case "part":
      return `${nick} left`;
    case "quit":
      return `${nick} quit`;
    case "kick":
      return `${nick} was kicked`;
    case "nick":
      return `${nick} changed nick`;
    case "topic":
      return `${nick} changed the topic`;
    case "mode":
      return `${nick} changed modes`;
    default:
      return "";
  }
}

function PresenceIcon({ kind }: { kind: MessageKind }) {
  const paths = (() => {
    switch (kind) {
      case "join":
        return (
          <>
            <circle cx="5.5" cy="5" r="2.2" />
            <path d="M1.8 13c0-2 1.7-3.2 3.7-3.2S9.2 11 9.2 13M12.5 4.5v5M10 7h5" />
          </>
        );
      case "part":
      case "quit":
        return <path d="M6.5 3H3v10h3.5M9.5 5l3 3-3 3M5.5 8h7" />;
      case "mode":
        return <path d="M8 1.8 13 4v3.4c0 3-2 5.5-5 6.8-3-1.3-5-3.8-5-6.8V4zM8 5v4M6 7h4" />;
      case "nick":
        return <path d="M3 5h9M9 2l3 3-3 3M13 11H4M7 8l-3 3 3 3" />;
      default:
        return null;
    }
  })();

  return (
    <svg
      data-ui="presence-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {paths}
    </svg>
  );
}

/**
 * Presence is weather, not speech: comings and goings fold into one line of
 * prose. Anything that changes who can read or speak is named in the first
 * clause and stays on screen whether the fold is open or shut.
 *
 * No spine, because a spine is what marks a run of speech.
 */
export function SystemMessage({
  messages,
  ownNick,
}: {
  messages: ChatMessage[];
  ownNick: string | null;
}) {
  const { loud, presence, plain } = partitionSystemRun(messages);
  const [expanded, setExpanded] = useState(false);
  const clockAtRail = useAppStore(
    (s) => s.presentation.clockSide === "before-spine" && s.presentation.clock !== "off",
  );
  // The digest is weather between two stretches of conversation, so it is given
  // the room a rule is given rather than the room a message is. Console output
  // is not: a run of it is nothing but these lines, and spacing each one apart
  // would set a whole `/help` as far apart as the channel it printed into.
  const digest = loud.length > 0 || presence.length > 0;
  const presenceSummary = summarizePresence(presence);
  const presenceSpan = describePresenceSpan(presence);

  return (
    <Block spine={false} railClock={<Clock at={messages[0]!.timestamp} column faint />}>
      <div
        className="flex items-start gap-2 text-[12px]"
        style={digest ? { paddingBlock: "var(--timeline-rule-gap)" } : undefined}
      >
        {!digest && !clockAtRail && <Clock at={messages[0]!.timestamp} />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {loud.length > 0 && (
            <span
              className="flex flex-wrap items-baseline gap-x-3"
              style={{ color: "var(--warning)" }}
            >
              <span>{loud.map(systemText).join(", ")}</span>
              {presence.length === 0 && !clockAtRail && (
                <Clock at={messages[0]!.timestamp} faint />
              )}
            </span>
          )}
          {presence.length > 0 && (
            <button
              type="button"
              aria-label={describePresenceRun(presence, ownNick)}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
              className="min-w-0 cursor-pointer text-left"
              style={{ color: "var(--text-muted)" }}
            >
              <span className="flex flex-col gap-1">
                {presenceSpan !== null && (
                  <span
                    data-ui="presence-span"
                    className="text-[10px] font-medium uppercase tracking-[0.08em]"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {presenceSpan}
                  </span>
                )}
                <span
                  data-ui="presence-events"
                  className="flex flex-wrap items-center gap-x-4 gap-y-1"
                >
                  {presenceSummary.map((summary) => {
                    const highlighted =
                      presenceInvolving(summary.messages, ownNick) >
                      summary.messages.filter((message) => message.sender.isSelf).length;
                    return (
                      <span
                        key={summary.verb}
                        data-event-kind={summary.kind}
                        className="flex items-center gap-1.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <PresenceIcon kind={summary.kind} />
                        <span
                          className={clsx(
                            highlighted &&
                              "underline decoration-[var(--accent)] underline-offset-2",
                          )}
                        >
                          {describePresenceSummary(summary, ownNick)}
                        </span>
                      </span>
                    );
                  })}
                  {!clockAtRail && <Clock at={messages[0]!.timestamp} faint />}
                </span>
              </span>
            </button>
          )}
        </div>
      </div>

      {expanded && presence.map((message) => <SystemLine key={message.id} message={message} />)}
      {runsOf(plain).map((run) => (
        <div key={run.messages[0]!.id}>
          {run.via !== null && (
            <div
              className="text-[11px] font-[family-name:var(--font-mono)]"
              style={{ color: "var(--text-faint)" }}
            >
              {run.via}
            </div>
          )}
          {run.messages.map((message) => (
            <SystemLine key={message.id} message={message} />
          ))}
        </div>
      ))}
    </Block>
  );
}

/**
 * Consecutive lines from the same place. A plugin answering in five lines is
 * named once above them rather than five times beside them, and the client's
 * own output is one run named not at all.
 *
 * Naming it matters because a plugin's answer is otherwise set exactly like
 * `/help`'s: the reader cannot tell what the client said from what somebody
 * else's code said in their conversation.
 */
function runsOf(messages: ChatMessage[]): { via: string | null; messages: ChatMessage[] }[] {
  const runs: { via: string | null; messages: ChatMessage[] }[] = [];
  for (const message of messages) {
    const last = runs.at(-1);
    if (last && last.via === message.via) last.messages.push(message);
    else runs.push({ via: message.via, messages: [message] });
  }
  return runs;
}

const LAID_OUT = "font-[family-name:var(--font-mono)] whitespace-pre-wrap";

/**
 * The face a system line is set in, chosen by its kind. What the client and the
 * server write is data, not speech: `/help`'s columns and a MOTD's ASCII rules
 * arrive already laid out, so they keep their spacing and the face it was
 * measured against. Every other kind is a sentence.
 *
 * The trade is the numerics ircx phrases itself, which arrive as `server` too
 * and do read as prose. They are a handful of one-line errors, each of which
 * also reaches the reader through the notice channel; the MOTD is the bulk of
 * what this kind carries.
 */
const FACE: Partial<Record<MessageKind, string>> = { client: LAID_OUT, server: LAID_OUT };

/**
 * A system line, and the controls for the transfer it announced where it
 * announced one.
 *
 * The row is where an offer is answered because the row is where the reader
 * already is: a panel they have to find first is a decision they have to be
 * told to go and make. What is drawn here and in that panel is the same
 * component, so the two cannot disagree about one file.
 */
function SystemLine({ message }: { message: ChatMessage }) {
  const transfer = useTransferFor(message.id);
  return (
    <div
      data-msgid={message.id}
      className={clsx("selectable text-[12px] break-words", FACE[message.kind])}
      style={{
        maxWidth: "var(--timeline-reading-measure, var(--timeline-measure))",
        color: message.kind === "server" ? "var(--text-faint)" : "var(--text-muted)",
      }}
    >
      {systemText(message)}
      {transfer !== undefined && <TransferControls transfer={transfer} />}
    </div>
  );
}
