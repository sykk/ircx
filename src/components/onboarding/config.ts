import type { NetworkConfig, SaslMechanism } from "@/types";
import { COMMON_NICK_LIMIT, nicknameProblem } from "./nickname";

export const TLS_PORT = 6697;
export const PLAIN_PORT = 6667;

export interface PublicNetwork {
  name: string;
  host: string;
  nickLimit: number;
  blurb: string;
}

export const PUBLIC_NETWORKS: PublicNetwork[] = [
  {
    name: "Libera.Chat",
    host: "irc.libera.chat",
    nickLimit: 16,
    blurb: "Free and open-source software projects and the people who build them.",
  },
  {
    name: "OFTC",
    host: "irc.oftc.net",
    nickLimit: COMMON_NICK_LIMIT,
    blurb: "Open and Free Technology Community — Debian, Tor, and neighbours.",
  },
  {
    name: "Rizon",
    host: "irc.rizon.net",
    nickLimit: COMMON_NICK_LIMIT,
    blurb: "A long-running general-purpose network.",
  },
];

/**
 * The form's own shape. Ports and lists are text here because that is what the
 * user types; `toConfig` is the only place that turns them into a
 * `NetworkConfig`.
 */
export interface Draft {
  /** Null until saved. Also what tells a stored password from no password. */
  id: string | null;
  name: string;
  host: string;
  port: string;
  tls: boolean;
  tlsVerify: boolean;
  /** Path to the PEM this network presents, or "" for none. What SASL EXTERNAL
   * authenticates with. Carried through the draft with no field drawing it yet,
   * because a draft that dropped it would clear a saved certificate the first
   * time somebody opened this network's settings and pressed save. */
  clientCertificate: string;
  nick: string;
  altNicks: string;
  username: string;
  realname: string;
  mechanism: SaslMechanism | "none";
  account: string;
  /** Null means "whatever the keyring already holds"; `save_network` leaves a
   * stored password alone when it arrives as null. */
  password: string | null;
  connectCommands: string;
  autojoin: string;
  autoConnect: boolean;
}

export function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    host: "",
    port: String(TLS_PORT),
    tls: true,
    tlsVerify: true,
    clientCertificate: "",
    nick: "",
    altNicks: "",
    username: "",
    realname: "",
    mechanism: "none",
    account: "",
    password: null,
    connectCommands: "",
    autojoin: "",
    autoConnect: true,
  };
}

export function presetDraft(network: PublicNetwork, from: Draft): Draft {
  return {
    ...from,
    name: network.name,
    host: network.host,
    port: String(TLS_PORT),
    tls: true,
    tlsVerify: true,
  };
}

/** A saved network read back through `list_network_configs`, in form shape. */
export function draftOf(config: NetworkConfig): Draft {
  return {
    id: config.id,
    name: config.name,
    host: config.host,
    port: String(config.port),
    tls: config.tls,
    tlsVerify: config.tlsVerify,
    clientCertificate: config.clientCertificate ?? "",
    nick: config.nick,
    altNicks: config.altNicks.join(" "),
    username: config.username,
    realname: config.realname,
    mechanism: config.sasl?.mechanism ?? "none",
    account: config.sasl?.account ?? "",
    password: null,
    connectCommands: config.connectCommands.join("\n"),
    autojoin: config.autojoin.join(" "),
    autoConnect: config.autoConnect,
  };
}

export function applyIdentity(draft: Draft, source: NetworkConfig): Draft {
  const mechanism = source.sasl?.mechanism ?? "none";
  return {
    ...draft,
    nick: source.nick,
    altNicks: source.altNicks.join(" "),
    username: source.username,
    realname: source.realname,
    mechanism,
    account: source.sasl?.account ?? "",
    password: needsPassword(mechanism) ? "" : null,
    clientCertificate: mechanism === "EXTERNAL" ? (source.clientCertificate ?? "") : "",
    connectCommands: source.connectCommands.join("\n"),
  };
}

/**
 * Whether the mechanism authenticates with a password the user has to give.
 *
 * Asked in one place because three asked it separately — whether to draw the
 * field, whether the saved one counts, and whether to send it — and a fourth
 * mechanism would have had to be added to all three or silently lose its
 * password in whichever was missed.
 */
export function needsPassword(mechanism: Draft["mechanism"]): boolean {
  return mechanism === "PLAIN" || mechanism.startsWith("SCRAM-");
}

/** Whether the password field should say "saved" instead of standing empty. */
export function hasStoredPassword(draft: Draft): boolean {
  return draft.id !== null && needsPassword(draft.mechanism) && draft.password === null;
}

export function toConfig(draft: Draft): NetworkConfig {
  const nick = draft.nick.trim();
  const host = draft.host.trim();
  const account = draft.account.trim() || nick;

  return {
    id: draft.id,
    name: draft.name.trim() || host,
    host,
    port: parsePort(draft.port) ?? (draft.tls ? TLS_PORT : PLAIN_PORT),
    tls: draft.tls,
    tlsVerify: draft.tlsVerify,
    clientCertificate: draft.clientCertificate.trim() || null,
    nick,
    altNicks: words(draft.altNicks),
    username: draft.username.trim() || nick,
    realname: draft.realname.trim() || nick,
    sasl:
      draft.mechanism === "none"
        ? null
        : {
            mechanism: draft.mechanism,
            account,
            password: needsPassword(draft.mechanism) ? draft.password : null,
          },
    connectCommands: lines(draft.connectCommands),
    autojoin: parseChannels(draft.autojoin),
    autoConnect: draft.autoConnect,
  };
}

export function nickLimitFor(host: string): number {
  const known = PUBLIC_NETWORKS.find((n) => n.host === host.trim().toLowerCase());
  return known?.nickLimit ?? COMMON_NICK_LIMIT;
}

export interface DraftProblems {
  host?: string;
  port?: string;
  nick?: string;
  clientCertificate?: string;
}

/** Everything the form can catch before the server does. */
export function draftProblems(draft: Draft): DraftProblems {
  const problems: DraftProblems = {};

  const host = draft.host.trim();
  if (host.length === 0) {
    problems.host = "Enter the server's address, like irc.example.org.";
  } else if (/\s/.test(host)) {
    problems.host = "A server address cannot contain spaces.";
  } else if (host.includes(":") || host.includes("/")) {
    problems.host = "Enter the address on its own — the port goes in the next field.";
  }

  if (parsePort(draft.port) === null) {
    problems.port = "A port is a whole number between 1 and 65535.";
  }

  const nick = nicknameProblem(draft.nick.trim(), nickLimitFor(draft.host));
  if (nick) problems.nick = nick;

  // Caught here rather than at the server, which answers a certificate-less
  // EXTERNAL with a 904 and no clue as to which setting is empty. Whether the
  // file is a certificate is the backend's to say; that it was named is this
  // form's.
  if (draft.mechanism === "EXTERNAL" && draft.clientCertificate.trim() === "") {
    problems.clientCertificate = "EXTERNAL logs in with a certificate. Choose the file first.";
  }

  return problems;
}

export function parsePort(text: string): number | null {
  const port = Number(text.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** "linux, #rust" becomes ["#linux", "#rust"]: the sigil is IRC's business. */
export function parseChannels(text: string): string[] {
  const named = words(text).map((c) => (/^[#&+!]/.test(c) ? c : `#${c}`));
  return [...new Set(named)];
}

function words(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** A leading slash is how the user writes a command everywhere else in the app,
 * so accept it and strip it rather than rejecting the line. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^\//, ""))
    .filter(Boolean);
}
