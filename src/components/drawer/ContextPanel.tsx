import { useCallback } from "react";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useChannelForView, useNetwork, useView } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import type { Member } from "@/types";
import { MemberList } from "./MemberList";
import { UserInspector } from "./UserInspector";

/* `useMembers` builds a fresh `[]` for a channel with no member list yet, which
 * useSyncExternalStore treats as a changed snapshot. Index the map instead. */
const NO_MEMBERS: Member[] = [];

/** It sits beside the conversation it lists rather than beside the window, so
 * it is narrower than a sidebar would be. */
export const ROSTER_PX = 208;

/** The member list for one pane, drawn inside that pane. Every pane on a
 * channel has its own: a roster is part of the conversation it belongs to, not
 * a piece of application furniture pointed at one pane at a time. */
export function ContextPanel({ view }: { view: ViewId | null }) {
  const pane = useView(view);
  const channel = useChannelForView(view);
  const network = useNetwork(channel?.network);
  const membersByTarget = useAppStore((s) => s.members);
  const toggleRoster = useAppStore((s) => s.toggleRoster);

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

  const key = channel === undefined ? null : targetKey(channel.network, channel.name);
  const members = key === null ? NO_MEMBERS : (membersByTarget[key] ?? NO_MEMBERS);

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
    <aside
      aria-label={`${channel.name} members`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (selectedNick !== null) setSelectedNick(null);
        else if (view) toggleRoster(view, false);
      }}
      className="flex h-full min-h-0 shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-sidebar)]"
      style={{ width: ROSTER_PX }}
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
  );
}
