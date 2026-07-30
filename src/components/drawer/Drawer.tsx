import { useCallback, useEffect } from "react";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useActiveChannel, useActiveView, useNetwork } from "@/store/selectors";
import type { Member } from "@/types";
import { MemberList } from "./MemberList";
import { UserInspector } from "./UserInspector";

/* `useMembers` builds a fresh `[]` for a channel with no member list yet, which
 * useSyncExternalStore treats as a changed snapshot. Index the map instead. */
const NO_MEMBERS: Member[] = [];

/** Mount unconditionally: the drawer renders nothing while closed, but it owns
 * the shortcut that opens it. */
export function Drawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const channel = useActiveChannel();
  const network = useNetwork(channel?.network);
  const membersByTarget = useAppStore((s) => s.members);

  // The inspector belongs to the pane, not to the drawer: retargeting the view
  // clears it in the store, so nothing here has to notice the channel changed.
  const view = useActiveView();
  const viewId = view?.id;
  const selectedNick = view?.selectedUser ?? null;
  const setViewSelectedUser = useAppStore((s) => s.setViewSelectedUser);
  const setSelectedNick = useCallback(
    (nick: string | null) => {
      if (viewId) setViewSelectedUser(viewId, nick);
    },
    [viewId, setViewSelectedUser],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        toggleDrawer();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDrawer]);

  const activeKey =
    channel === undefined ? null : targetKey(channel.network, channel.name);
  const members =
    activeKey === null ? NO_MEMBERS : (membersByTarget[activeKey] ?? NO_MEMBERS);

  if (!open || channel === undefined || activeKey === null) return null;

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
        else toggleDrawer(false);
      }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* Same height and rule as a pane header, so the line under the header
          carries on into the panel and the panel reads as part of that
          conversation rather than as application furniture. Naming the channel
          says which pane the panel is following, which matters once there are
          two of them. */}
      <div className="flex h-11 shrink-0 items-center border-b border-[var(--border-default)] px-3 text-[var(--text-secondary)]">
        {channel.name}
      </div>

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
