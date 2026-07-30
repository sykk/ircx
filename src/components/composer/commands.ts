export interface SlashCommand {
  name: string;
  usage: string;
  summary: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "join", usage: "/join #channel [key]", summary: "Join a channel" },
  { name: "part", usage: "/part [#channel] [reason]", summary: "Leave a channel" },
  { name: "query", usage: "/query nick", summary: "Open a private conversation" },
  { name: "msg", usage: "/msg target text", summary: "Send without opening a tab" },
  { name: "me", usage: "/me text", summary: "Send an action" },
  { name: "notice", usage: "/notice target text", summary: "Send a notice" },
  { name: "react", usage: "/react msgid value", summary: "React to a message" },
  { name: "unreact", usage: "/unreact msgid value", summary: "Take a reaction back" },
  { name: "nick", usage: "/nick newnick", summary: "Change your nickname" },
  { name: "topic", usage: "/topic [text]", summary: "Show or set the topic" },
  { name: "mode", usage: "/mode target modes", summary: "Change channel or user modes" },
  { name: "kick", usage: "/kick nick [reason]", summary: "Remove someone from the channel" },
  { name: "invite", usage: "/invite nick [#channel]", summary: "Invite someone" },
  { name: "whois", usage: "/whois nick", summary: "Look someone up" },
  { name: "away", usage: "/away [reason]", summary: "Set or clear away status" },
  { name: "quit", usage: "/quit [reason]", summary: "Disconnect from the network" },
  { name: "raw", usage: "/raw line", summary: "Send a protocol line unchanged" },
];

/** The commands to hint for, or null when the caret is not on a bare command word. */
export function matchCommands(text: string): SlashCommand[] | null {
  const typed = /^\/([a-z0-9]*)$/i.exec(text);
  if (!typed) return null;
  const prefix = typed[1]!.toLowerCase();
  const matches = COMMANDS.filter((c) => c.name.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}
