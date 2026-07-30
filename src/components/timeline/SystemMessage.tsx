import { useState } from "react";
import clsx from "clsx";
import type { ChatMessage, MessageKind } from "@/types";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { Block } from "./MessageBlock";
import { describePresence, partitionSystemRun } from "./rows";

/**
 * Backends that phrase the event themselves win; the fallback exists so a bare
 * `join` with no text still reads as a sentence rather than an empty row.
 */
function systemText(message: ChatMessage): string {
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

/**
 * Presence is weather, not speech: comings and goings fold into one line of
 * prose. Anything that changes who can read or speak is named in the first
 * clause and stays on screen whether the fold is open or shut.
 *
 * No spine, because a spine is what marks a run of speech.
 */
export function SystemMessage({ messages }: { messages: ChatMessage[] }) {
  const { loud, presence, plain } = partitionSystemRun(messages);
  const [expanded, setExpanded] = useState(false);

  return (
    <Block at={messages[0]!.timestamp} spine={false}>
      {(loud.length > 0 || presence.length > 0) && (
        <div className="flex items-baseline gap-2 text-[12px]">
          {loud.length > 0 && (
            <span style={{ color: "var(--warning)" }}>
              {loud.map(systemText).join(", ")}
              {presence.length > 0 && " —"}
            </span>
          )}
          {presence.length > 0 && (
            <>
              <span className="min-w-0 flex-1" style={{ color: "var(--text-muted)" }}>
                {describePresence(presence)}
              </span>
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="shrink-0 text-[11px]"
                style={{ color: "var(--accent)" }}
              >
                {expanded ? "hide" : "show all"}
              </button>
            </>
          )}
        </div>
      )}

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

function SystemLine({ message }: { message: ChatMessage }) {
  return (
    <div
      data-msgid={message.id}
      className={clsx("selectable text-[12px] break-words", FACE[message.kind])}
      style={{
        maxWidth: "var(--timeline-measure)",
        color: message.kind === "server" ? "var(--text-faint)" : "var(--text-muted)",
      }}
    >
      {systemText(message)}
    </div>
  );
}
