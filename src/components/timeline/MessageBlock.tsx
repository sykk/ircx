import type { ReactNode } from "react";
import type { ChatMessage } from "@/types";
import { nickColor } from "@/lib/nickColor";
import { useAppStore } from "@/store";
import { isHighlight, type HighlightRule } from "@/store/selectors";
import { Clock } from "./Clock";
import type { Group } from "./groups";
import { MessageRow } from "./MessageRow";
import { failureRuns, writesOwnNick } from "./rows";

const LADDER = "var(--timeline-spine-width) var(--timeline-spine-gap) minmax(0, 1fr)";
/** The same ladder with the spine's two columns closed up, for a reader who
 * turned it off: the room a spine would have taken goes back to the prose
 * rather than standing empty at the rail. */
const FLAT = "0 0 minmax(0, 1fr)";

interface BlockProps {
  spine: boolean;
  /** What the spine is drawn in. The default marks a run of speech and no more. */
  spineTint?: string | undefined;
  /** This block continues a group the block above opened, so its spine has to
   * climb through the gap between them. Without it a group's rule breaks once
   * per author and a solid group reads as a dashed one. */
  spineContinues?: boolean;
  dimmed?: boolean;
  onSpineClick?: (() => void) | undefined;
  spinePressed?: boolean;
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
  dimmed = false,
  onSpineClick,
  spinePressed = false,
  children,
}: BlockProps) {
  const drawn = useAppStore((s) => s.presentation.spine);
  const align = useAppStore((s) => s.presentation.align);
  // Closing the gap between two blocks of one group is the spine's doing: it is
  // what spans the gap and says they are one thing. With no spine to span it
  // the blocks would run together with nothing accounting for it, so the gap
  // comes back and the group is left to its name and its nick colours.
  const continues = drawn && spineContinues;

  return (
    <div
      className="grid"
      style={{
        width: "100%",
        maxWidth: "calc(var(--timeline-rail-pad) + var(--timeline-spine-width) + var(--timeline-spine-gap) + var(--timeline-reading-measure, var(--timeline-measure)) + var(--timeline-actions-col) + var(--timeline-actions-gap) + 16px)",
        marginInline: align === "center" ? "auto" : undefined,
        opacity: dimmed ? "var(--disabled-opacity)" : undefined,
        gridTemplateColumns: drawn ? LADDER : FLAT,
        paddingLeft: "var(--timeline-rail-pad)",
        paddingRight: "16px",
        // The gap between blocks moves onto the content column when a group
        // continues, so the spine spans the whole row and the two blocks meet
        // with nothing between them. Cancelling the padding with a negative
        // margin instead left a hairline of background at every boundary —
        // arithmetic that was one pixel out, on every author, all the way down.
        paddingTop: continues ? undefined : "var(--timeline-block-gap)",
      }}
    >
      {spine && drawn && onSpineClick !== undefined ? (
        <button
          type="button"
          data-spine="solid"
          data-ui="group-spine"
          className="rounded-[var(--radius-sm)] hover:bg-[var(--surface-hover)]"
          aria-label={spinePressed ? "Show all conversations" : "Focus this conversation"}
          aria-pressed={spinePressed}
          title={spinePressed ? "Show all conversations" : "Focus this conversation"}
          onClick={onSpineClick}
          style={{
            gridColumn: 1,
            width: "calc(var(--timeline-spine-width) + var(--timeline-spine-gap))",
            // A border rather than a fill: only a border can be dashed.
            borderLeftWidth: "var(--timeline-spine-width)",
            borderLeftStyle: "solid",
            borderLeftColor: spineTint,
            // Overlap the block above by a pixel. Block heights are fractional,
            // so a boundary rounds either way and leaves a hairline of
            // background at some of them and not others — measured on a
            // screenshot, invisible in jsdom, and worse than a clean break
            // because it reads as an accident rather than as a division.
            marginTop: continues ? "-1px" : undefined,
          }}
        />
      ) : spine && drawn ? (
        <div
          data-spine="solid"
          style={{
            gridColumn: 1,
            borderLeftWidth: "var(--timeline-spine-width)",
            borderLeftStyle: "solid",
            borderLeftColor: spineTint,
            marginTop: continues ? "-1px" : undefined,
          }}
          aria-hidden="true"
        />
      ) : null}
      <div
        style={{
          gridColumn: 3,
          paddingTop: continues ? "var(--timeline-block-gap)" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface Props {
  messages: ChatMessage[];
  ownNick: string | null;
  highlight: HighlightRule;
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
  focusedGroup?: string | null;
  onFocusGroup?: (group: string | null) => void;
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
    <div data-ui="group-name" className="flex items-baseline gap-2 text-[11px]">
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
 *
 * A reader who wants it on every line can have it, and this head is what goes
 * when they do: `SenderPrefix` in MessageRow states who and when in front of
 * each line instead. What does not come back is the column — the prefix is in
 * the flow of the prose, so the left edge is where the first word is and no
 * name can move it.
 */
export function MessageBlock({
  messages,
  ownNick,
  highlight,
  parentOf,
  onJump,
  canTag,
  onReact,
  onReply,
  flashId,
  group,
  opensGroup,
  present,
  focusedGroup = null,
  onFocusGroup,
}: Props) {
  const head = messages[0]!;
  const brackets = useAppStore((s) => s.presentation.nickBrackets);
  const clockSide = useAppStore((s) => s.presentation.clockSide);
  const clock = useAppStore((s) => s.presentation.clock);
  const everyLine = useAppStore((s) => s.presentation.nickEveryLine);
  const compactSingletons = useAppStore((s) => s.presentation.compactSingletons);
  const nickColors = useAppStore((s) => s.presentation.nickColors);
  const compactSingleton = compactSingletons && messages.length === 1 && !writesOwnNick(head.kind);
  const addressed = messages.some((message) => isHighlight(message, highlight, present));
  const failures = failureRuns(messages);
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

  const name =
    writesOwnNick(head.kind) || everyLine || compactSingleton ? null : (
      <span
        className="font-[family-name:var(--font-mono)] text-[13px] font-semibold"
        style={{ color: nickColors ? nickColor(head.sender.nick) : "var(--text-primary)" }}
      >
        {brackets ? `<${head.sender.nick}>` : head.sender.nick}
      </span>
    );
  // Nothing to line the prose up behind when the clock prints nothing.
  const leadingClock = clockSide === "left" && clock !== "off";

  const rows = messages.map((message, at) => (
    <MessageRow
      key={message.id}
      failure={failures[at]!}
      message={message}
      quotedAbove={repeatsQuote(messages, at)}
      ownNick={ownNick}
      highlight={highlight}
      parentOf={parentOf}
      onJump={onJump}
      canTag={canTag}
      onReact={onReact}
      onReply={onReply}
      present={present}
      flashing={message.id === flashId}
      prefixSender={compactSingleton}
    />
  ));

  return (
    <Block
      spine
      spineTint={spineTint}
      spineContinues={group !== null && !opensGroup}
      dimmed={focusedGroup !== null && group?.id !== focusedGroup}
      onSpineClick={group === null || onFocusGroup === undefined ? undefined : () => onFocusGroup(group.id)}
      spinePressed={group !== null && group.id === focusedGroup}
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
          <span style={{ color: nickColors ? nickColor(head.sender.nick) : "var(--text-primary)" }}>
            {head.sender.nick}
          </span>{" "}
          addressed
          you by name
        </div>
      )}
      {/* The name in front of the clock, the clock in front of the name, or
          neither: an action and a notice write their own nick into the body,
          and a reader who asked for the name on every line is about to be told
          who and when by each row for itself. */}
      {name === null ? (
        rows
      ) : leadingClock ? (
        /* The clock opens a column and the run is set beside it, so the prose
           starts under the name exactly as it does with the clock behind it.
           A grid rather than an indent: the column is as wide as the clock in
           the mono face the reader chose, which is a width this element cannot
           name in pixels. `Clock` holds it to the widest the format prints, so
           the edge does not move when the hour rolls over to two digits. */
        <div
          data-ui="clock-column"
          className="grid items-baseline"
          style={{ gridTemplateColumns: "max-content minmax(0, 1fr)", columnGap: "8px" }}
        >
          <Clock at={head.timestamp} column />
          {name}
          <div style={{ gridColumn: 2 }}>{rows}</div>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            {name}
            <Clock at={head.timestamp} />
          </div>
          {rows}
        </>
      )}
    </Block>
  );
}
