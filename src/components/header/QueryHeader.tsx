import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { ipc } from "@/lib/ipc";
import { sendFileTo } from "@/lib/transfers";
import { useAppStore } from "@/store";
import { targetKey, sameTarget } from "@/store/keys";
import { useNetwork, useQueryForView } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ClosePaneButton } from "./ClosePaneButton";
import { HeaderButton } from "./HeaderButton";
import { ClearIcon, OverflowIcon, SearchIcon } from "./icons";

/**
 * What a private conversation is called, and what can be done with it.
 *
 * A query had no header at all: the pane was a timeline and a composer, and the
 * only thing naming it was the composer's placeholder, which goes as soon as
 * anybody types. Two queries side by side were then indistinguishable.
 *
 * It is not `ChannelHeader` with the channel parts hidden. Half of that header
 * is about a room — the member count, the roster toggle, the topic banner, the
 * invite form — and a conversation with one person has none of those. What the
 * two share is the row they sit in and the buttons they draw, which is what
 * `HeaderButton` and `ClosePaneButton` already are; `ConsoleHeader` is a third
 * header on the same terms.
 *
 * There is no catch-up here, and its absence is the deliberate part. Catch-up
 * keeps the unread messages that mention you, answer you, or were reacted to.
 * In a channel that is the difference between what was said and what was said
 * to you; in a query everything was said to you, and filtering on a nick that
 * mostly is not typed would hide the conversation rather than summarise it.
 */
export function QueryHeader({ view }: { view: ViewId | null }) {
  const query = useQueryForView(view);
  const network = useNetwork(query?.network);
  // The nick carries the focus indicator, so an unfocused pane reads a step
  // quieter. With one pane there is nothing to tell apart.
  const focused = useAppStore((s) => s.viewOrder.length < 2 || s.activeViewId === view);
  const ignored = useAppStore((s) => (query ? (s.ignored[query.network] ?? EMPTY) : EMPTY));
  const openSearch = useAppStore((s) => s.openSearch);
  const clearBuffer = useAppStore((s) => s.clearBuffer);
  const openSetup = useAppStore((s) => s.openSetup);

  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);

  if (query === undefined) return null;

  const isIgnored = ignored.some((nick) => sameTarget(nick, query.nick));

  const run = async (input: string) => {
    setMenuOpen(false);
    setError(null);
    try {
      const outcome = await ipc.submitInput(query.network, query.nick, input);
      if (outcome.kind === "rejected") setError(outcome.value);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The command could not be sent.");
    }
  };

  const sendFile = async () => {
    setMenuOpen(false);
    setError(null);
    try {
      await sendFileTo(query.network, query.nick);
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "The file could not be offered.");
    }
  };

  return (
    <header className="contents">
      <div
        data-ui="query-header-row"
        className="col-span-2 row-start-1 flex h-10 items-center gap-2.5 bg-[var(--surface-base)] px-3"
      >
        <h1
          className={clsx(
            "min-w-0 shrink truncate text-[15px] font-medium",
            focused ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]",
          )}
        >
          {query.nick}
        </h1>
        {/* Said in the sidebar's terms, and meaning what it means there: not
            heard from since a quit was seen, rather than known to be away. */}
        <span className="flex shrink-0 items-center gap-1.5 text-[var(--text-muted)]">
          <span
            className="h-2 w-2 rounded-full"
            style={{
              background: query.online
                ? "var(--state-connected)"
                : "var(--state-disconnected)",
            }}
          />
          {query.online ? "online" : "offline"}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <HeaderButton label={`Search ${query.nick}`} onClick={() => openSearch()}>
            <SearchIcon size={16} />
          </HeaderButton>

          <HeaderButton
            label={`Clear ${query.nick} buffer`}
            title="Clear buffer"
            onClick={() => clearBuffer(targetKey(query.network, query.nick))}
          >
            <ClearIcon size={16} />
          </HeaderButton>

          <div
            className="relative"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setMenuOpen(false);
            }}
          >
            <HeaderButton
              label="More actions"
              expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <OverflowIcon size={16} />
            </HeaderButton>

            {menuOpen && (
              <div
                role="menu"
                aria-label={`${query.nick} actions`}
                className="absolute top-full right-0 z-10 mt-1 w-56 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
              >
                {/* Whois and ignoring reach a person through the member list
                    everywhere else, and a query has no member list. Without
                    these there is no way to either from inside the
                    conversation they are about. */}
                <MenuItem onClick={() => void run(`/whois ${query.nick}`)}>Whois</MenuItem>
                <MenuItem onClick={() => void sendFile()}>Send a file…</MenuItem>
                <MenuItem
                  onClick={() =>
                    void run(`${isIgnored ? "/unignore" : "/ignore"} ${query.nick}`)
                  }
                >
                  {isIgnored ? "Stop ignoring" : "Ignore"}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    openSetup(query.network);
                  }}
                >
                  {network ? `${network.name} settings` : "Network settings"}
                </MenuItem>
              </div>
            )}
          </div>

          <ClosePaneButton view={view} />
        </div>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-ui="query-header-error"
          className="col-span-2 row-start-2 border-b border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-1.5 text-[var(--danger)]"
        >
          {error}
        </p>
      )}
    </header>
  );
}

/** Shared so an absent lookup returns one stable reference, not a fresh array. */
const EMPTY: string[] = [];

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
