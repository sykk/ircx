import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useActiveChannel, useNetwork } from "@/store/selectors";
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

  const [selectedNick, setSelectedNick] = useState<string | null>(null);

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

  // The selected nick belongs to a channel; switching channel drops it.
  const [selectionFrom, setSelectionFrom] = useState(activeKey);
  if (selectionFrom !== activeKey) {
    setSelectionFrom(activeKey);
    setSelectedNick(null);
  }

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
