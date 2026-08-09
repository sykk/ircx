import type { ChatMessage, MessageKind } from "@/types";

/**
 * The conversation the appearance preview is set in.
 *
 * Written out rather than generated, and not taken from
 * src/components/timeline/fixtures.ts, whose first line is the reason: nothing
 * in the render path imports that file, and this is the render path. It is
 * also the wrong shape for the job — those messages are seeded noise, and what
 * a preview has to show is each thing a setting changes, once, where the
 * reader will look for it.
 *
 * So the script is chosen for what the grouping rules make of it, and
 * src/components/timeline/groups.ts is what decides that:
 *
 *   - Two lines from one person inside a minute, which is a run. The clock and
 *     the name are stated once above it, or in front of every line, and this
 *     is the block where that setting is visible.
 *   - `mira: …` answered by `sam: …`, which opens an addressed group between
 *     the two of them. Its spine takes mira's colour, hers being the message
 *     that started it.
 *   - `[sasl]`, which declares a group by name and takes anybody. Its spine is
 *     alex's, and the name is written above the first block.
 *   - A mode change, which is the one system line here. It is `loud`, so it is
 *     drawn in the warning colour and no fold covers it.
 *
 * A message left in no group keeps a neutral spine, which is the fourth state
 * and why the first two lines are not addressed to anybody.
 */

export const PREVIEW_NETWORK = "ircx";
export const PREVIEW_TARGET = "#ircd-dev";
export const PREVIEW_TOPIC = "ircd development";

/** Who is in the channel. The roster beside the timeline draws these, and
 * `assignGroups` needs them for a different reason: a word before a colon is
 * an address only if it names somebody who is here. */
export const PREVIEW_MEMBERS: readonly string[] = [
  "alex",
  "mira",
  "sam",
  "ircx",
  "volt",
  "zane",
  "kiwi",
  "nova",
  "quill",
  "byte",
  "luna",
  "opal",
];

/** The reader, so the preview can show a line that names them. */
export const PREVIEW_OWN_NICK = "sam";

interface Line {
  /** Local wall clock, `HH:MM:SS`. Seconds differ so the format that prints
   * them is not a column of `:00`. */
  at: string;
  nick: string;
  text: string;
  kind?: MessageKind;
}

const SCRIPT: readonly Line[] = [
  { at: "10:22:14", nick: "alex", text: "shipped the new build" },
  { at: "10:22:41", nick: "alex", text: "the /who and /list lag is gone" },
  { at: "10:23:08", nick: "mira", text: "looks clean" },
  { at: "10:24:02", nick: "sam", text: "mira: was that the cache change?" },
  { at: "10:24:37", nick: "mira", text: "sam: mostly — the rest was the parser" },
  { at: "10:31:19", nick: "alex", text: "[sasl] EXTERNAL still wants a real certificate" },
  { at: "10:32:05", nick: "sam", text: "a staging cert works, the live one does not" },
  { at: "10:34:12", nick: "mira", text: "set +n", kind: "mode" },
];

/**
 * The script as messages, dated today.
 *
 * Today because the timeline draws a date rule above the first message of a
 * day and `describeDay` writes that one "Today" — a fixed date would put a
 * date from the past at the top of a preview of the window as it is now.
 * `now` is a parameter so a test does not have to be run at a particular hour.
 */
export function previewMessages(now: Date = new Date()): ChatMessage[] {
  return SCRIPT.map(({ at, nick, text, kind }, index) => ({
    id: `preview-${index}`,
    idIsLocal: true,
    via: null,
    network: PREVIEW_NETWORK,
    target: PREVIEW_TARGET,
    kind: kind ?? "privmsg",
    sender: {
      nick,
      user: null,
      host: null,
      account: null,
      isSelf: nick === PREVIEW_OWN_NICK,
    },
    timestamp: stamp(now, at),
    timestampIsLocal: false,
    text,
    tags: [],
    replyTo: null,
    batch: null,
    delivery: { state: "delivered" },
    attachments: [],
    encryption: "plaintext",
    raw: "",
    source: "live",
  }));
}

/** `HH:MM:SS` today, as the RFC 3339 UTC a message carries. Built through the
 * local-time constructor so the clock reads back the hour that was written
 * here whatever the reader's offset is. */
function stamp(now: Date, at: string): string {
  const [hours = 0, minutes = 0, seconds = 0] = at.split(":").map(Number);
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    seconds,
  ).toISOString();
}
