import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useActiveChannel, useNetwork } from "@/store/selectors";
import type { Member } from "@/types";
import { ChannelInfoTab } from "./ChannelInfoTab";
import { ChannelSettingsTab } from "./ChannelSettingsTab";
import { MemberList } from "./MemberList";
import { NotificationsTab } from "./NotificationsTab";
import { UserInspector } from "./UserInspector";
import { BellIcon, CloseIcon, GearIcon, InfoIcon, MembersIcon } from "./icons";

const TABS = [
  { id: "members", label: "Members", Icon: MembersIcon },
  { id: "info", label: "Channel info", Icon: InfoIcon },
  { id: "notifications", label: "Notifications", Icon: BellIcon },
  { id: "settings", label: "Channel settings", Icon: GearIcon },
] as const;

type DrawerTab = (typeof TABS)[number]["id"];

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

  const [tab, setTab] = useState<DrawerTab>("members");
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
      aria-label={`${channel.name} drawer`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (selectedNick !== null) setSelectedNick(null);
        else toggleDrawer(false);
      }}
      className="flex h-full w-65 shrink-0 flex-col border-l border-[var(--border-default)] bg-[var(--surface-sidebar)]"
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <h2 className="truncate text-[15px] text-[var(--text-primary)]">{channel.name}</h2>
        <button
          type="button"
          aria-label="Close drawer"
          onClick={() => toggleDrawer(false)}
          className="ml-auto rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <CloseIcon />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Drawer sections"
        className="flex gap-1 border-b border-[var(--border-subtle)] px-2 pb-2"
      >
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            id={`drawer-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            title={label}
            aria-label={label}
            onClick={() => setTab(id)}
            className={`flex flex-1 justify-center rounded-[var(--radius-md)] py-1.5 ${
              tab === id
                ? "bg-[var(--surface-active)] text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        aria-labelledby={`drawer-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "members" &&
          (selected === undefined ? (
            <MemberList
              members={members}
              selected={selectedNick}
              onSelect={setSelectedNick}
            />
          ) : (
            <UserInspector
              network={channel.network}
              channel={channel.name}
              member={selected}
              self={self}
              onBack={() => setSelectedNick(null)}
            />
          ))}
        {tab === "info" && <ChannelInfoTab channel={channel} network={network} />}
        {tab === "notifications" && (
          <NotificationsTab
            key={activeKey}
            channelKey={activeKey}
            channelName={channel.name}
          />
        )}
        {tab === "settings" && (
          <ChannelSettingsTab
            key={activeKey}
            channelKey={activeKey}
            channelName={channel.name}
          />
        )}
      </div>
    </aside>
  );
}
