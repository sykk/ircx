import type { Attachment, ChatMessage, MessageKind } from "@/types";

/**
 * Message sets for tests and for scrolling the timeline by hand. Nothing in the
 * render path imports this; the app's only source of messages is the store.
 *
 * Generation is seeded so a failing assertion reproduces from the seed alone.
 */

const NICKS = ["sable", "phrack", "nyx", "kade", "marrow", "wren", "jolt", "spiral"];

const LINES = [
  "got the LFI — the template loader will happily read /proc/self/environ",
  "is the flag in the env or are we chaining",
  "chaining, no flag, but the database credentials are right there",
  "heap layout after the second free — the chunk is on the tcache list twice",
  "rejoining after the laptop, the desktop is rebuilding",
  "no rush, we are stuck on pwn-300 anyway",
  "try `strings` on the binary first, the author left a build path in there",
  "**do not** rerun the exploit against prod, the box is shared",
  "```\nfor i in range(64):\n    heap.free(i)\n```",
  "the writeup is up, ~~half~~ most of it is accurate",
];

const SYSTEM_KINDS: MessageKind[] = ["join", "part", "quit", "nick", "mode", "server"];

/** Mulberry32. Short, and identical output across Node versions. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MessageOverrides extends Partial<ChatMessage> {
  nick?: string;
}

export function makeMessage({ nick, ...overrides }: MessageOverrides = {}): ChatMessage {
  const sender = {
    nick: nick ?? "sable",
    user: null,
    host: null,
    account: null,
    isSelf: false,
  };
  return {
    id: "m0",
    idIsLocal: false,
    network: "libera",
    target: "#ctf-ops",
    kind: "privmsg",
    sender,
    timestamp: "2026-07-29T02:41:00.000Z",
    timestampIsLocal: false,
    text: "hello",
    tags: [],
    replyTo: null,
    batch: null,
    delivery: { state: "delivered" },
    attachments: [],
    encryption: "plaintext",
    raw: "",
    source: "live",
    ...overrides,
  };
}

export function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    url: "https://files.example/burp-req.png",
    filename: "burp-req.png",
    mime: "image/png",
    sizeBytes: 1_153_433n,
    preview: null,
    ...overrides,
  };
}

export interface ConversationOptions {
  count: number;
  seed?: number;
  /** Epoch ms of the first message. Later messages advance by up to 4 minutes. */
  startedAt?: number;
  network?: string;
  target?: string;
}

/**
 * A run of messages with the mix a busy channel produces: grouped chatter,
 * bursts of joins and parts, a few replies, the odd attachment.
 */
export function makeConversation({
  count,
  seed = 1,
  startedAt = Date.parse("2026-07-29T00:00:00.000Z"),
  network = "libera",
  target = "#ctf-ops",
}: ConversationOptions): ChatMessage[] {
  const random = rng(seed);
  const messages: ChatMessage[] = [];
  let at = startedAt;
  let nick = NICKS[0]!;

  for (let i = 0; i < count; i++) {
    at += Math.floor(random() * 240_000);
    const roll = random();

    if (roll < 0.18) {
      messages.push(
        makeMessage({
          id: `m${i}`,
          network,
          target,
          nick: NICKS[Math.floor(random() * NICKS.length)]!,
          kind: SYSTEM_KINDS[Math.floor(random() * SYSTEM_KINDS.length)]!,
          timestamp: new Date(at).toISOString(),
          text: "",
        }),
      );
      continue;
    }

    if (roll > 0.72) nick = NICKS[Math.floor(random() * NICKS.length)]!;

    const previous = messages[messages.length - 1];
    messages.push(
      makeMessage({
        id: `m${i}`,
        network,
        target,
        nick,
        kind: roll > 0.95 ? "action" : roll > 0.92 ? "notice" : "privmsg",
        timestamp: new Date(at).toISOString(),
        text: LINES[Math.floor(random() * LINES.length)]!,
        replyTo: random() < 0.08 && previous ? previous.id : null,
        attachments: random() < 0.05 ? [makeAttachment({ url: `https://files.example/${i}.png` })] : [],
      }),
    );
  }

  return messages;
}
