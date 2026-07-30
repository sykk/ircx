import { useState } from "react";
import type { ChatMessage } from "@/types";
import { Block } from "./MessageBlock";
import { describePresence, partitionSystemRun } from "./rows";

/**
 * Backends that phrase the event themselves win; the fallback exists so a bare
 * `join` with no text still reads as a sentence rather than an empty row.
 */
function systemText(message: ChatMessage): string {
  if (message.text.trim() !== "") return message.text;
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
      {plain.map((message) => (
        <SystemLine key={message.id} message={message} />
      ))}
    </Block>
  );
}

function SystemLine({ message }: { message: ChatMessage }) {
  return (
    <div
      data-msgid={message.id}
      className="selectable text-[12px] break-words"
      style={{
        maxWidth: "var(--measure)",
        color: message.kind === "server" ? "var(--text-faint)" : "var(--text-muted)",
      }}
    >
      {systemText(message)}
    </div>
  );
}
