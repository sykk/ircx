import { useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { ipc, openExternal } from "@/lib/ipc";
import { leavingLabel } from "@/components/common/LeavesTheClient";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { useChannelForView, useNetwork } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ClosePaneButton } from "./ClosePaneButton";
import { HeaderButton } from "./HeaderButton";
import {
  CatchUpIcon,
  ChevronIcon,
  MembersIcon,
  OverflowIcon,
  SearchIcon,
} from "./icons";

export function ChannelHeader({
  view,
  catchUp = false,
  onCatchUp,
}: {
  view: ViewId | null;
  catchUp?: boolean;
  onCatchUp?: () => void;
}) {
  const channel = useChannelForView(view);
  const network = useNetwork(channel?.network);
  // The channel name carries the focus indicator, so an unfocused pane reads a
  // step quieter. With one pane there is nothing to tell apart.
  const focused = useAppStore((s) => s.viewOrder.length < 2 || s.activeViewId === view);
  const rosterShown = useAppStore((s) => (view ? s.rosterHidden[view] !== true : false));
  const toggleRoster = useAppStore((s) => s.toggleRoster);
  const openSearch = useAppStore((s) => s.openSearch);
  const clearBuffer = useAppStore((s) => s.clearBuffer);
  const openSetup = useAppStore((s) => s.openSetup);

  const [menuOpen, setMenuOpen] = useState(false);
  const [topicExpanded, setTopicExpanded] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [invitee, setInvitee] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [topicError, setTopicError] = useState<string | null>(null);
  useAnnounce(error);
  useAnnounce(topicError);

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

  const topic = channel.topic?.text ? channel.topic : null;

  return (
    <header className="contents">
      <div
        data-ui="channel-header-row"
        className="col-start-1 row-start-1 flex h-10 min-w-0 items-center gap-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-base)] px-3"
      >
        <h1
          className={clsx(
            "shrink-0 text-[15px] font-medium",
            focused ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]",
          )}
        >
          {channel.name}
        </h1>

        {topic !== null && !topicExpanded && (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <p
              title={topic.text}
              className="selectable min-w-0 truncate text-[var(--text-secondary)]"
            >
              <CollapsedTopic
                text={topic.text}
                onOpen={(url) => {
                  setTopicError(null);
                  void openExternal(url).catch((reason: unknown) => {
                    setTopicError(`Could not open ${url} — ${String(reason)}`);
                  });
                }}
              />
            </p>
            <button
              type="button"
              aria-label="Expand topic"
              aria-expanded={false}
              onClick={() => setTopicExpanded(true)}
              className="shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <span className="block rotate-[-90deg]">
                <ChevronIcon size={14} />
              </span>
            </button>
          </div>
        )}

        <span
          aria-label={`${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`}
          title={`${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`}
          className={clsx(
            "flex shrink-0 items-center gap-1 text-[var(--text-muted)]",
            topic === null ? "mr-auto" : topicExpanded && "ml-auto",
          )}
        >
          <MembersIcon size={14} />
          <span aria-hidden="true">{channel.memberCount}</span>
        </span>

        <div className="flex shrink-0 items-center gap-1">
          {onCatchUp && (
            <HeaderButton
              label="Catch up"
              title={
                catchUp
                  ? "Return to all messages"
                  : "Show unread mentions, replies, reactions, and important events"
              }
              pressed={catchUp}
              onClick={onCatchUp}
            >
              <CatchUpIcon size={16} />
            </HeaderButton>
          )}

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
            onClick={() => openSearch()}
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
                    <MenuItem
                      danger
                      onClick={() => {
                        closeMenu();
                        clearBuffer(targetKey(channel.network, channel.name));
                      }}
                    >
                      Clear buffer
                    </MenuItem>
                  </>
                )}
              </div>
            )}
          </div>

          <ClosePaneButton view={view} />
        </div>
      </div>

      {topic !== null && (topicExpanded || topicError !== null) && (
        <div
          data-ui="topic-banner"
          className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 border-b border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-1.5"
        >
          {topicExpanded && (
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <p
                title={topic.text}
                className="selectable min-w-0 whitespace-pre-wrap break-words text-[var(--text-primary)]"
              >
                {topic.text}
              </p>
              {(topic.setBy !== null || topic.setAt !== null) && (
                <p className="max-w-[45%] shrink-0 truncate text-[11px] text-[var(--text-muted)]">
                  {topicMetadata(topic.setBy, topic.setAt)}
                </p>
              )}
            </div>
          )}
          {topicError !== null && (
            <span role="alert" className="min-w-0 flex-1 truncate text-[11px] text-[var(--danger)]">
              {topicError}
            </span>
          )}
          {topicExpanded && (
            <button
              type="button"
              aria-label="Collapse topic"
              aria-expanded={true}
              onClick={() => setTopicExpanded(false)}
              className="shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <ChevronIcon size={14} />
            </button>
          )}
        </div>
      )}
    </header>
  );
}

interface TopicSegment {
  label: string | null;
  url: string | null;
  text: string;
}

export function parseTopicSegments(text: string): TopicSegment[] {
  return text.split(/\s+(?:--|—|\|)\s+/).map((segment) => {
    const linked = segment.match(/^(.*?):\s*(https?:\/\/\S+)(.*)$/);
    if (linked === null) return { label: null, url: null, text: segment };
    return {
      label: linked[1]!.trim(),
      url: linked[2]!,
      text: linked[3]!.trim(),
    };
  });
}

function CollapsedTopic({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  const segments = parseTopicSegments(text);
  return segments.map((segment, index) => (
    <span key={`${segment.url ?? segment.text}:${index}`}>
      {index > 0 && <span className="px-1.5 text-[var(--text-faint)]">·</span>}
      {segment.url === null ? (
        segment.text
      ) : (
        <>
          <button
            type="button"
            aria-label={leavingLabel(segment.url)}
            title={segment.url}
            onClick={() => {
              if (segment.url !== null) onOpen(segment.url);
            }}
            className="text-[var(--accent)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--accent-hover)]"
          >
            {segment.label}
          </button>
          {segment.text !== "" && ` ${segment.text}`}
        </>
      )}
    </span>
  ));
}

function topicMetadata(setBy: string | null, setAt: string | null): string {
  const setter = setBy === null ? null : `Set by ${setBy}`;
  const timestamp = setAt === null ? null : formatTopicTimestamp(setAt);
  return [setter, timestamp].filter((part) => part !== null).join(" on ");
}

export function formatTopicTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const day = date.toISOString().slice(0, 10);
  const time = date.toISOString().slice(11, 16);
  return `${day} at ${time} UTC`;
}

function MenuItem({
  onClick,
  children,
  danger = false,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        "w-full rounded-[var(--radius-sm)] px-2 py-1 text-left hover:bg-[var(--surface-hover)]",
        danger
          ? "text-[var(--danger)] hover:text-[var(--danger)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
      )}
    >
      {children}
    </button>
  );
}
