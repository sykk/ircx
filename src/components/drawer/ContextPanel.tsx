import { useCallback, useState } from "react";
import clsx from "clsx";
import { OverflowIcon } from "@/components/header/icons";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useChannelForView, useNetwork, useView } from "@/store/selectors";
import type { ContextMode, ViewId } from "@/store/types";
import type { Member } from "@/types";
import { MemberList } from "./MemberList";
import { UserInspector } from "./UserInspector";

/* `useMembers` builds a fresh `[]` for a channel with no member list yet, which
 * useSyncExternalStore treats as a changed snapshot. Index the map instead. */
const NO_MEMBERS: Member[] = [];

/** Narrower than the shared sidebar's 264: embedded, it is competing with the
 * conversation it sits beside rather than with the window. */
export const EMBEDDED_PX = 208;

interface ContextPanelProps {
  /** The pane whose roster this shows. */
  view: ViewId | null;
  /** Rendered inside that pane rather than in the shared sidebar. */
  embedded?: boolean;
}

/** The members panel for one pane. `Drawer` mounts it in the shared sidebar;
 * `ChatPane` mounts it inside the pane in embedded mode. */
export function ContextPanel({ view, embedded = false }: ContextPanelProps) {
  const pane = useView(view);
  const channel = useChannelForView(view);
  const network = useNetwork(channel?.network);
  const membersByTarget = useAppStore((s) => s.members);
  const mode = useAppStore((s) => s.contextMode);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);

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

  // Following focus, a pane with no channel has no roster and the panel steps
  // aside. Attached to one it has to stay put even so: the ⋮ in this header is
  // the only way back out of pinned or embedded.
  if (channel === undefined && mode === "follow") return null;

  const selected = members.find((m) => m.nick === selectedNick);
  const currentNick = network?.currentNick ?? null;
  const self =
    currentNick === null
      ? undefined
      : members.find((m) => sameTarget(m.nick, currentNick));

  return (
    <aside
      aria-label={channel === undefined ? "Members" : `${channel.name} members`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (selectedNick !== null) setSelectedNick(null);
        else toggleDrawer(false);
      }}
      className={clsx(
        "flex h-full min-h-0 flex-col",
        embedded &&
          "shrink-0 border-l border-[var(--border-subtle)] bg-[var(--surface-sidebar)]",
      )}
      style={embedded ? { width: EMBEDDED_PX } : undefined}
    >
      {/* Same height and rule as a pane header, so the line under the header
          carries on into the panel and the panel reads as part of that
          conversation rather than as application furniture. Naming the channel
          says which pane the panel is following, which matters once there are
          two of them. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3 text-[var(--text-secondary)]">
        {/* Embedded, the pane's own header names the channel a few inches to
            the left on the same rule; repeating it would be dead chrome. */}
        {!embedded && (
          <>
            <span className="truncate">{channel?.name ?? "No channel"}</span>
            {mode === "pinned" && (
              <span className="shrink-0 text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase">
                Pinned
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        <ModeMenu />
      </div>

      {channel === undefined ? (
        <p className="px-3 py-4 text-[var(--text-muted)]">
          This pane is not on a channel.
        </p>
      ) : selected === undefined ? (
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

const MODES: { mode: ContextMode; label: string }[] = [
  { mode: "follow", label: "Follow the focused pane" },
  { mode: "pinned", label: "Pin to this pane" },
  { mode: "embedded", label: "Show inside this pane" },
];

/** The three modes live here rather than in a preferences surface, which this
 * client does not have — see #34. */
function ModeMenu() {
  const mode = useAppStore((s) => s.contextMode);
  const setContextMode = useAppStore((s) => s.setContextMode);
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label="Panel placement"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Panel placement"
        onClick={() => setOpen((was) => !was)}
        className={clsx(
          "rounded-[var(--radius-md)] p-1.5 hover:bg-[var(--surface-hover)]",
          open
            ? "text-[var(--accent)]"
            : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
        )}
      >
        <OverflowIcon size={16} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Panel placement"
          className="absolute top-full right-0 z-10 mt-1 w-56 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
        >
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="menuitemradio"
              aria-checked={item.mode === mode}
              onClick={() => {
                setContextMode(item.mode);
                setOpen(false);
              }}
              className={clsx(
                "w-full rounded-[var(--radius-sm)] px-2 py-1 text-left",
                item.mode === mode
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
