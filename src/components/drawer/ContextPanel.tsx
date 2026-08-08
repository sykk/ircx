import { useCallback, useRef, type RefObject } from "react";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useChannelForView, useNetwork, useView } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import type { Member } from "@/types";
import { MemberList } from "./MemberList";
import { UserInspector } from "./UserInspector";

/** Shared so an absent lookup returns one stable reference, not a fresh literal. */
const NO_MEMBERS: Member[] = [];

/**
 * The roster is as wide as the names in it, not as wide as a column somebody
 * chose. Three nicks reserving the room four hundred would need is what made a
 * split pane unreadable — see #114.
 *
 * The list is monospace, so a character is exactly one `ch` and the arithmetic
 * is not a guess — which is why the column carries the mono family itself
 * rather than leaving it to the rows: `ch` is measured against the element the
 * width is on. It has to be arithmetic rather than `width: fit-content` because
 * `MemberList` virtualises: its rows are positioned absolutely and contribute
 * no intrinsic width for the browser to fit to.
 *
 * The floor is set by the widest group header rather than by a name:
 * `Operators — 1` is drawn whatever the nicks are, and it sits in a row of
 * fixed height, so a header that wraps meets the member below it.
 */
const ROSTER_MIN = "8rem";
/** What it used to always be. A nick longer than this truncates rather than
 * taking the conversation's room. */
const ROSTER_MAX = "13rem";
/** Everything on a row that is not the name: the list's padding and the row's,
 * the presence dot, and the gap either side of the sigil. */
const ROSTER_GUTTER = "3.5rem";

/** What the names ask for, which is what the column is until somebody drags it
 * to a width of their own. */
export function rosterWidth(members: readonly Member[], inspecting: boolean): string {
  // The inspector is prose and a set of fields rather than a list of names, so
  // it takes the full column whatever the longest nick happens to be.
  if (inspecting) return ROSTER_MAX;
  const widest = members.reduce(
    (chars, member) => Math.max(chars, member.prefixes.join("").length + member.nick.length),
    0,
  );
  return `clamp(${ROSTER_MIN}, ${widest}ch + ${ROSTER_GUTTER}, ${ROSTER_MAX})`;
}

/** The member list for one pane, drawn inside that pane. Every pane on a
 * channel has its own: a roster is part of the conversation it belongs to, not
 * a piece of application furniture pointed at one pane at a time. */
export function ContextPanel({ view }: { view: ViewId | null }) {
  const pane = useView(view);
  const channel = useChannelForView(view);
  const network = useNetwork(channel?.network);
  const key = channel === undefined ? null : targetKey(channel.network, channel.name);
  // One entry, not the whole map: subscribing to `s.members` re-rendered every
  // pane's panel on a join or part in any channel on any network.
  const members = useAppStore((s) => (key === null ? NO_MEMBERS : (s.members[key] ?? NO_MEMBERS)));
  const toggleRoster = useAppStore((s) => s.toggleRoster);
  const dragged = useAppStore((s) => s.rosterWidth);
  const ref = useRef<HTMLElement>(null);

  // The inspector belongs to the pane, not to the panel: retargeting the view
  // clears it in the store, so nothing here has to notice the channel changed.
  const selectedNick = pane?.selectedUser ?? null;
  const setViewSelectedUser = useAppStore((s) => s.setViewSelectedUser);
  const setSelectedNick = useCallback(
    (nick: string | null) => {
      if (view) setViewSelectedUser(view, nick);
    },
    [view, setViewSelectedUser],
  );

  // A query or a console has nobody to list, and an empty column standing in
  // for a roster is worse than the space it costs.
  if (channel === undefined) return null;

  const selected = members.find((m) => m.nick === selectedNick);
  const currentNick = network?.currentNick ?? null;
  const self =
    currentNick === null
      ? undefined
      : members.find((m) => sameTarget(m.nick, currentNick));

  return (
    <>
      <RosterHandle roster={ref} width={dragged} />
      <aside
        ref={ref}
          aria-label={`${channel.name} members`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (selectedNick !== null) setSelectedNick(null);
          else if (view) toggleRoster(view, false);
        }}
        /* Below 440px of pane the roster gives way and the conversation has the
           width. Against the pane rather than the window — `@container` is on
           `ChatPane` — because two panes side by side are one window and two very
           different widths.

           The roster does not shrink: `shrink-0`, with a width clamped between
           8rem and 13rem, or between 8rem and 400px once somebody has dragged
           it. So on a narrow pane it used to win outright, and #367
           photographed the result at 760px with the divider dragged in — 114px of
           pane that was all roster, the timeline gone, the composer's hint
           wrapped one word wide.

           440 is measured, not picked. Three widths dragged in Chrome and read
           off the screenshots in `docs/end-to-end-run-7.md`: a 323px pane wraps
           message text to one character a line, 403 wraps at word boundaries and
           reads, 483 is comfortable. Those had a 157px roster and its ceiling is
           208, so a pane wants about 208 + 232 before it can hold both. Below
           that the roster is what goes, because a conversation without a member
           list is still a conversation and a member list without a conversation
           is not one.

           A floor on the divider was measured instead and rejected: 440 on each
           side of a 960px split leaves it about 40px of travel, which is most of
           a control given up for a case that only bites at the end of its range. */
        className="flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-sidebar)] font-mono @max-[440px]:hidden"
        style={{
          width:
            dragged === null
              ? rosterWidth(members, selected !== undefined)
              : `${dragged}px`,
        }}
      >
        {/* Empty, and the same height and rule as the pane header a few inches to
            the left, so the line under that header carries on into the roster and
            the two read as one conversation. The header already names the channel
            and counts its members; repeating either here would be dead chrome. */}
        <div className="h-11 shrink-0 border-b border-[var(--border-default)]" />

        {selected === undefined ? (
          <MemberList members={members} selected={selectedNick} onSelect={setSelectedNick} />
        ) : (
          <UserInspector
            network={channel.network}
            channel={channel.name}
            member={selected}
            self={self}
            onBack={() => setSelectedNick(null)}
          />
        )}
      </aside>
    </>
  );
}

/**
 * The roster's left edge, dragged. It hides with the column it sizes, on the
 * same 440px of pane, so a pane too narrow to hold a roster does not keep the
 * handle to one.
 *
 * The width a drag starts from is measured off the column rather than read from
 * the store, because until somebody has dragged it the store holds null and the
 * column is as wide as its longest name — which is the width the pointer is
 * over and the one it has to continue from. That null is also why
 * `aria-valuenow` is absent until a drag: there is no number to report while the
 * column is still answering to the names in it.
 */
function RosterHandle({
  roster,
  width,
}: {
  roster: RefObject<HTMLElement | null>;
  width: number | null;
}) {
  const setRosterWidth = useAppStore((s) => s.setRosterWidth);
  const from = useRef<{ x: number; width: number } | null>(null);

  const drawn = () => roster.current?.getBoundingClientRect().width ?? 0;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Member list width"
      aria-valuenow={width ?? undefined}
      aria-valuemin={128}
      aria-valuemax={400}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize hover:bg-[var(--accent-muted)] @max-[440px]:hidden"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        from.current = { x: event.clientX, width: drawn() };
      }}
      onPointerMove={(event) => {
        // Against the drag's start rather than the last move, so a pointer past
        // either end of the range comes back on the pixel it left rather than
        // where it has wandered to since.
        const start = from.current;
        if (start) setRosterWidth(start.width + (start.x - event.clientX));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        from.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") setRosterWidth(drawn() + 16);
        else if (event.key === "ArrowRight") setRosterWidth(drawn() - 16);
        else return;
        event.preventDefault();
      }}
    />
  );
}
