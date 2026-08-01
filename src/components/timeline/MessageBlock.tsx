import type { ReactNode } from "react";
import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";
import { isHighlight } from "@/store/selectors";
import type { Group } from "./groups";
import { MessageRow } from "./MessageRow";
import { formatClock, writesOwnNick } from "./rows";

const LADDER = "var(--timeline-spine-width) var(--timeline-spine-gap) minmax(0, 1fr)";

interface BlockProps {
  spine: boolean;
  /** What the spine is drawn in. The default marks a run of speech and no more. */
  spineTint?: string | undefined;
  /** This block continues a group the block above opened, so its spine has to
   * climb through the gap between them. Without it a group's rule breaks once
   * per author and a solid group reads as a dashed one. */
  spineContinues?: boolean;
  children: ReactNode;
}

/**
 * The ladder every row hangs from: a spine, then the content column. Speech and
 * presence share it, so one left edge runs the length of the pane whatever any
 * given block turns out to contain.
 *
 * The clock used to open the ladder in a column of its own. It cost 120px
 * before the first word and printed only when the minute changed, so most rows
 * paid for it and left it empty. It is in the block header now.
 */
export function Block({
  spine,
  spineTint = "var(--border-strong)",
  spineContinues = false,
  children,
}: BlockProps) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: LADDER,
        paddingLeft: "var(--timeline-rail-pad)",
        paddingRight: "16px",
        // The gap between blocks moves onto the content column when a group
        // continues, so the spine spans the whole row and the two blocks meet
        // with nothing between them. Cancelling the padding with a negative
        // margin instead left a hairline of background at every boundary —
        // arithmetic that was one pixel out, on every author, all the way down.
        paddingTop: spineContinues ? undefined : "var(--timeline-block-gap)",
      }}
    >
      {spine && (
        <div
          data-spine="solid"
          style={{
            gridColumn: 1,
            // A border rather than a fill: only a border can be dashed.
            borderLeftWidth: "var(--timeline-spine-width)",
            borderLeftStyle: "solid",
            borderLeftColor: spineTint,
            // Overlap the block above by a pixel. Block heights are fractional,
            // so a boundary rounds either way and leaves a hairline of
            // background at some of them and not others — measured on a
            // screenshot, invisible in jsdom, and worse than a clean break
            // because it reads as an accident rather than as a division.
            marginTop: spineContinues ? "-1px" : undefined,
          }}
          aria-hidden="true"
        />
      )}
      <div
        style={{
          gridColumn: 3,
          paddingTop: spineContinues ? "var(--timeline-block-gap)" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The time a block began, set in the same face and size wherever it appears. */
export function Clock({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] tabular-nums"
      style={{ color: "var(--text-faint)" }}
    >
      {formatClock(at)}
    </time>
  );
}

interface Props {
  messages: ChatMessage[];
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  canTag: boolean;
  onReact: (msgid: string, emoji: string, active: boolean) => void;
  onReply: (msgid: string) => void;
  flashId: string | null;
  group: Group | null;
  opensGroup: boolean;
  /** Who is in the conversation, folded. A sender who is not cannot be
   * addressing anybody in it. */
  present: ReadonlySet<string>;
}

/**
 * The name of a declared group, above the first block in it.
 *
 * Only the declared grade is named, because it is the only one a person named.
 * An addressed group carries no label — both people are in the blocks below in
 * their own colours, so a caption naming them says nothing new.
 */
function GroupName({ name, tint }: { name: string; tint: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="font-[family-name:var(--font-mono)] font-medium" style={{ color: tint }}>
        {name}
      </span>
    </div>
  );
}

/**
 * Whether the message above this one already quoted the same parent, and so
 * said what this one is answering.
 */
function repeatsQuote(messages: ChatMessage[], at: number): boolean {
  const above = messages[at - 1];
  const message = messages[at]!;
  return above !== undefined && message.replyTo !== null && message.replyTo === above.replyTo;
}

/**
 * One run of one person's lines: their name and the time stated once above it,
 * and every line beneath starting at the same left edge as the name.
 *
 * The nickname used to be printed beside every line, in a column sized to the
 * widest name the block held. Because a block was a minute, that column changed
 * width from one minute to the next and took the prose with it: five different
 * left edges on one screen of #libera-dev. The name is still written out in
 * full, being the identifier colour only reinforces — once, at the head.
 */
export function MessageBlock({
  messages,
  ownNick,
  parentOf,
  onJump,
  canTag,
  onReact,
  onReply,
  flashId,
  group,
  opensGroup,
  present,
}: Props) {
  const head = messages[0]!;
  const addressed = messages.some((message) => isHighlight(message, ownNick, present));
  // A rule raises a message to the same loudness a mention has — the badge
  // does not distinguish them — so the spine says so the same way. Which line
  // and which rule is on the row, where the message is.
  const raised = messages.some((message) => (message.raisedBy ?? []).length > 0);

  // The group keeps the spine; a mention takes it only where there is no group
  // to lose.
  //
  // This was the other way round, on the argument that a mention has nowhere
  // else to go. It has two: the block prints "X addressed you by name" above
  // the run, and the row itself is tinted. The spine was a third mark on the
  // same message and the only one carrying something the others cannot — which
  // conversation it belongs to.
  //
  // Watching an exchange settled it. A reply to you names you, because that is
  // what replying on IRC is, so the accent took the second block of every
  // exchange the reader was in and the hue survived only on conversations
  // between other people.
  const groupTint = group === null ? undefined : nickColor(group.opener);
  const spineTint = groupTint ?? (addressed || raised ? "var(--accent)" : undefined);

  return (
    <Block
      spine
      spineTint={spineTint}
      spineContinues={group !== null && !opensGroup}
    >
      {opensGroup && group !== null && group.name !== null && (
        <GroupName name={group.name} tint={groupTint ?? "var(--text-faint)"} />
      )}
      {/* Why the run is marked, in the words for it. A tint on its own leaves
          the reader to work out what the client noticed, and the answer — your
          name is in here — is the one thing they cannot get from the colour.
          Certain rather than inferred: it is their own nick, matched by the
          same pattern that decided to highlight the row at all. */}
      {addressed && (
        <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          <span style={{ color: nickColor(head.sender.nick) }}>{head.sender.nick}</span> addressed
          you by name
        </div>
      )}
      {/* An action or a notice writes its own nick into the body, so a header
          would say the name the first line is about to say again. */}
      {!writesOwnNick(head.kind) && (
        <div className="flex items-baseline gap-2">
          <span
            className="font-[family-name:var(--font-mono)] text-[13px] font-semibold"
            style={{ color: nickColor(head.sender.nick) }}
          >
            {head.sender.nick}
          </span>
          <Clock at={head.timestamp} />
        </div>
      )}
      {messages.map((message, at) => (
        <MessageRow
          key={message.id}
          message={message}
          quotedAbove={repeatsQuote(messages, at)}
          ownNick={ownNick}
          parentOf={parentOf}
          onJump={onJump}
          canTag={canTag}
          onReact={onReact}
          onReply={onReply}
          present={present}
          flashing={message.id === flashId}
        />
      ))}
    </Block>
  );
}
