import { useState, type FormEvent } from "react";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { useActiveChannel } from "@/store/selectors";
import { InviteIcon, MembersIcon, PanelIcon, SearchIcon } from "./icons";

export function ChannelHeader() {
  const channel = useActiveChannel();
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const toggleSearch = useAppStore((s) => s.toggleSearch);

  const [inviting, setInviting] = useState(false);
  const [invitee, setInvitee] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (channel === undefined) return null;

  const topic = channel.topic?.text ?? "";

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
      setInviting(false);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The invite could not be sent.");
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--surface-base)] px-3">
      <h1 className="shrink-0 text-[15px] font-medium text-[var(--text-primary)]">
        {channel.name}
      </h1>
      {topic !== "" && (
        <p
          title={topic}
          className="selectable min-w-0 flex-1 truncate text-[var(--text-secondary)]"
        >
          {topic}
        </p>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span
          title={`${channel.memberCount} members in ${channel.name}`}
          className="flex items-center gap-1.5 text-[var(--text-secondary)]"
        >
          <MembersIcon />
          {channel.memberCount}
        </span>

        <div className="relative">
          <button
            type="button"
            aria-expanded={inviting}
            onClick={() => setInviting((open) => !open)}
            className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <InviteIcon />
            Invite
          </button>
          {inviting && (
            <form
              onSubmit={invite}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setInviting(false);
                }
              }}
              className="absolute top-full right-0 z-10 mt-1 w-64 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-2 shadow-[var(--shadow-overlay)]"
            >
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
          )}
        </div>

        <button
          type="button"
          onClick={() => toggleSearch(true)}
          aria-label={`Search ${channel.name}`}
          className="flex w-44 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-default)] px-2 py-1 text-[var(--text-muted)] hover:border-[var(--border-strong)]"
        >
          <SearchIcon />
          Search
        </button>

        <button
          type="button"
          onClick={() => toggleDrawer()}
          aria-pressed={drawerOpen}
          aria-label="Toggle member drawer"
          title="Member drawer (Ctrl+Shift+M)"
          className={`rounded-[var(--radius-md)] p-1.5 hover:bg-[var(--surface-hover)] ${
            drawerOpen ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
          }`}
        >
          <PanelIcon size={16} />
        </button>
      </div>
    </header>
  );
}
