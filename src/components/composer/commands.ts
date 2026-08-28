import { ipc } from "@/lib/ipc";

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
  /**
   * Where the command runs.
   *
   * Almost everything is `session`: it is typed at a conversation, reaches
   * `dispatch.rs`, and usually leaves as a line. `connection` is the other
   * kind — it acts on the connection rather than travelling over it, so the
   * window performs it and nothing is sent. `/connect` could not be a session
   * command even in principle: after a disconnect the session is gone, and
   * there is nothing left to type at.
   */
  runs?: "session" | "connection";
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
  { name: "ctcp", args: "<nick> <command> [args]", summary: "Send a CTCP query" },
  { name: "react", args: "<msgid> <value>", summary: "React to a message" },
  { name: "unreact", args: "<msgid> <value>", summary: "Take a reaction back" },
  { name: "nick", args: "<nick>", summary: "Change your nickname" },
  { name: "setname", args: "<text>", summary: "Change the real name a whois shows" },
  { name: "topic", args: "[topic]", summary: "Show or set the channel topic" },
  { name: "mode", args: "<target> <modes>", summary: "Change channel or user modes" },
  { name: "kick", args: "<nick> [reason]", summary: "Remove someone from the channel" },
  { name: "invite", args: "<nick> [channel]", summary: "Invite someone" },
  { name: "list", args: "[pattern]", summary: "List the channels on this network" },
  { name: "whois", args: "<nick>", summary: "Look someone up" },
  { name: "whowas", args: "<nick>", summary: "Look up somebody who has gone" },
  { name: "away", args: "[reason]", summary: "Mark yourself away" },
  { name: "back", args: "", summary: "Come back from away" },
  { name: "ignore", args: "[nick]", summary: "Stop hearing from someone, or list who is ignored" },
  { name: "unignore", args: "<nick>", summary: "Hear from them again" },
  { name: "watch", args: "[nick|-nick]", summary: "Watch a nick, remove one, or list them" },
  { name: "quit", args: "[reason]", summary: "Disconnect from the network" },
  { name: "raw", args: "<line>", summary: "Send a protocol line unchanged" },
  { name: "close", args: "[target]", summary: "Close this conversation and forget it" },
  {
    name: "connect",
    args: "",
    summary: "Connect this network",
    runs: "connection",
  },
  {
    name: "disconnect",
    args: "[reason]",
    summary: "Disconnect this network, leaving its conversations open",
    runs: "connection",
  },
  { name: "help", args: "", summary: "List the commands ircx knows" },
];

/** What the composer prints above the box. */
export function usage(command: SlashCommand): string {
  return command.args === "" ? `/${command.name}` : `/${command.name} ${command.args}`;
}

/** What the window does itself, rather than sending. Returns false for
 * anything that belongs to a session, which the caller then submits as usual. */
export async function runConnectionCommand(
  input: string,
  network: string,
): Promise<boolean> {
  if (!input.startsWith("/")) return false;
  const [typed = "", ...rest] = input.slice(1).split(" ");
  const command = COMMANDS.find(
    (known) => known.runs === "connection" && known.name === typed.toLowerCase(),
  );
  if (!command) return false;

  if (command.name === "connect") await ipc.connectNetwork(network);
  else await ipc.disconnectNetwork(network, rest.join(" ").trim() || undefined);
  return true;
}

/** The commands to hint for, or null when the caret is not on a bare command word. */
export function matchCommands(text: string): SlashCommand[] | null {
  const typed = /^\/([a-z0-9]*)$/i.exec(text);
  if (!typed) return null;
  const prefix = typed[1]!.toLowerCase();
  const matches = COMMANDS.filter((c) => c.name.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}

/**
 * The one channel `input` joins, if it joins exactly one.
 *
 * A join is typed to read the channel, so the pane goes there — from the
 * composer as much as from the palette, which was the only route to a join
 * before any conversation was open and so the only place this was done. `/join`
 * elsewhere sent the line and left the reader where they were, with the channel
 * in the sidebar and nothing on screen to say it had worked.
 *
 * The name has to be a channel already: core prefixes an unprefixed one with
 * whatever the network's `CHANTYPES` starts with, which is a fact the window
 * does not hold. A join of several at once names no single channel to show.
 */
export function channelJoinedBy(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const [name = "", channel = ""] = input.slice(1).split(/\s+/);
  if (!["join", "j"].includes(name.toLowerCase())) return null;
  return /^[#&!+][^,]*$/.test(channel) ? channel : null;
}
