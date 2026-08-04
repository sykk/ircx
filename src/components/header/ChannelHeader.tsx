import { useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { useChannelForView, useNetwork } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ClosePaneButton } from "./ClosePaneButton";
import { HeaderButton } from "./HeaderButton";
import { MembersIcon, OverflowIcon, SearchIcon } from "./icons";

export function ChannelHeader({ view }: { view: ViewId | null }) {
  const channel = useChannelForView(view);
  const network = useNetwork(channel?.network);
  // The channel name carries the focus indicator, so an unfocused pane reads a
  // step quieter. With one pane there is nothing to tell apart.
  const focused = useAppStore((s) => s.viewOrder.length < 2 || s.activeViewId === view);
  const rosterShown = useAppStore((s) => (view ? s.rosterHidden[view] !== true : false));
  const toggleRoster = useAppStore((s) => s.toggleRoster);
  const toggleSearch = useAppStore((s) => s.toggleSearch);
  const openSetup = useAppStore((s) => s.openSetup);

  const [menuOpen, setMenuOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [invitee, setInvitee] = useState("");
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);

  if (channel === undefined) return null;

  function closeMenu() {
    setMenuOpen(false);
    setInviting(false);
    setError(null);
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const nick = invitee.trim();
    if (!nick) return;
    setError(null);
    try {
      const outcome = await ipc.submitInput(
        channel.network,
        channel.name,
        `/invite ${nick} ${channel.name}`,
      );
      if (outcome.kind === "rejected") {
        setError(outcome.value);
        return;
      }
      setInvitee("");
      closeMenu();
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The invite could not be sent.");
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--surface-base)] px-3">
      <h1
        className={clsx(
          "shrink-0 text-[15px] font-medium",
          focused ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]",
        )}
      >
        {channel.name}
      </h1>
      <span className="shrink-0 text-[var(--text-muted)]">
        {channel.memberCount} {channel.memberCount === 1 ? "member" : "members"}
      </span>
      {/* What the channel says it is for, where a reader can see it without
       * having been present when it was said. The timeline draws it once on
       * join and once per change and then it scrolls away, and until #345
       * nothing else in the app drew it at all.
       *
       * `min-w-0 flex-1 truncate` rather than a width: the topic takes what is
       * left after the name and the count and gives the controls their room
       * back, so a long one cannot push them off the end. The title is how a
       * truncated one is read. */}
      {channel.topic !== null && channel.topic.text !== "" && (
        <p
          title={channel.topic.text}
          className="selectable min-w-0 flex-1 truncate text-[var(--text-muted)]"
        >
          {channel.topic.text}
        </p>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <HeaderButton
          label="Toggle member list"
          title="Member list (Ctrl+Shift+M)"
          pressed={rosterShown}
          onClick={() => view && toggleRoster(view)}
        >
          <MembersIcon size={16} />
        </HeaderButton>

        <HeaderButton
          label={`Search ${channel.name}`}
          onClick={() => toggleSearch(true)}
        >
          <SearchIcon size={16} />
        </HeaderButton>

        <div
          className="relative"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeMenu();
          }}
        >
          <HeaderButton
            label="More actions"
            expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            <OverflowIcon size={16} />
          </HeaderButton>

          {menuOpen && (
            <div
              role="menu"
              aria-label={`${channel.name} actions`}
              className="absolute top-full right-0 z-10 mt-1 w-64 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
            >
              {inviting ? (
                <form onSubmit={invite} className="p-1">
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      value={invitee}
                      onChange={(event) => setInvitee(event.target.value)}
                      aria-label={`Nick to invite to ${channel.name}`}
                      placeholder="nick"
                      className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 py-1 text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                    />
                    <button
                      type="submit"
                      className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-2 py-1 text-[var(--text-inverse)] hover:bg-[var(--accent-hover)]"
                    >
                      Send
                    </button>
                  </div>
                  {error !== null && (
                    <p role="alert" className="pt-1 text-[var(--danger)]">
                      {error}
                    </p>
                  )}
                </form>
              ) : (
                <>
                  <MenuItem onClick={() => setInviting(true)}>Invite</MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      openSetup(channel.network);
                    }}
                  >
                    {network ? `${network.name} settings` : "Network settings"}
                  </MenuItem>
                </>
              )}
            </div>
          )}
        </div>

        <ClosePaneButton view={view} />
      </div>
    </header>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full rounded-[var(--radius-sm)] px-2 py-1 text-left text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}
