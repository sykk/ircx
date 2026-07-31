/**
 * The commands ircx knows, in one place.
 *
 * The composer's hints and the palette both read this. They each had their own
 * copy and the two had drifted: the palette offered `/connect`, `/disconnect`
 * and `/close`, which `dispatch.rs` has no arm for and rejects as unknown, and
 * neither list mentioned `/help` or `/list`, which it does have.
 *
 * `src/types/contract.test.ts` holds it against the dispatch table, so a
 * command added to one and not the other fails the build rather than the user.
 */
export interface SlashCommand {
  name: string;
  /** `<>` is required and `[]` is optional. The palette reads the angle
   * brackets to tell a command still short of an argument from one ready to
   * run, so the convention is load-bearing rather than decorative. */
  args: string;
  summary: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "join", args: "<channel> [key]", summary: "Join a channel" },
  { name: "part", args: "[channel] [reason]", summary: "Leave a channel" },
  { name: "query", args: "<nick>", summary: "Open a private conversation" },
  { name: "msg", args: "<target> <message>", summary: "Send without opening a tab" },
  { name: "me", args: "<action>", summary: "Send an action" },
  { name: "notice", args: "<target> <message>", summary: "Send a notice" },
  { name: "react", args: "<msgid> <value>", summary: "React to a message" },
  { name: "unreact", args: "<msgid> <value>", summary: "Take a reaction back" },
  { name: "nick", args: "<nick>", summary: "Change your nickname" },
  { name: "topic", args: "[topic]", summary: "Show or set the channel topic" },
  { name: "mode", args: "<target> <modes>", summary: "Change channel or user modes" },
  { name: "kick", args: "<nick> [reason]", summary: "Remove someone from the channel" },
  { name: "invite", args: "<nick> [channel]", summary: "Invite someone" },
  { name: "list", args: "[pattern]", summary: "List the channels on this network" },
  { name: "whois", args: "<nick>", summary: "Look someone up" },
  { name: "away", args: "[reason]", summary: "Set or clear away status" },
  { name: "quit", args: "[reason]", summary: "Disconnect from the network" },
  { name: "raw", args: "<line>", summary: "Send a protocol line unchanged" },
  { name: "close", args: "[target]", summary: "Close this conversation and forget it" },
  { name: "help", args: "", summary: "List the commands ircx knows" },
];

/** What the composer prints above the box. */
export function usage(command: SlashCommand): string {
  return command.args === "" ? `/${command.name}` : `/${command.name} ${command.args}`;
}

/** The commands to hint for, or null when the caret is not on a bare command word. */
export function matchCommands(text: string): SlashCommand[] | null {
  const typed = /^\/([a-z0-9]*)$/i.exec(text);
  if (!typed) return null;
  const prefix = typed[1]!.toLowerCase();
  const matches = COMMANDS.filter((c) => c.name.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}
