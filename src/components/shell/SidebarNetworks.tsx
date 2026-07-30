import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Badge } from "@/components/common/Badge";
import { ipc } from "@/lib/ipc";
import { Icon } from "@/components/common/Icon";
import { OverflowIcon } from "@/components/header/icons";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import { useActiveTarget } from "@/store/selectors";
import { SERVER_TARGET, type Channel, type Network, type Query } from "@/types";
import { connectionColor, connectionLabel } from "./connection";

type Row =
  | {
      id: string;
      kind: "network";
      network: Network;
      collapsed: boolean;
      unread: number;
      highlights: number;
    }
  | { id: string; kind: "channel"; channel: Channel }
  | { id: string; kind: "query"; query: Query; network: Network };

/** Modes that make a channel non-public: key, invite only, secret, private.
 * Only the flag token is inspected — a channel key is a mode parameter and may
 * itself contain any of those letters. */
function isRestricted(channel: Channel): boolean {
  const flags = channel.modes.split(" ")[0] ?? "";
  return /[kisp]/.test(flags);
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function SidebarNetworks() {
  const networks = useAppStore((s) => s.networks);
  const networkOrder = useAppStore((s) => s.networkOrder);
  const channels = useAppStore((s) => s.channels);
  const queries = useAppStore((s) => s.queries);
  const collapsedNetworks = useAppStore((s) => s.collapsedNetworks);
  const active = useActiveTarget();
  const showTarget = useAppStore((s) => s.showTarget);
  const openConsole = useAppStore((s) => s.openConsole);
  const toggleNetworkCollapsed = useAppStore((s) => s.toggleNetworkCollapsed);
  const openSetup = useAppStore((s) => s.openSetup);

  // The store's list selectors build a fresh array per call, which React's
  // useSyncExternalStore treats as a changed snapshot; deriving here keeps the
  // subscriptions on the stable record objects.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const id of networkOrder) {
      const network = networks[id];
      if (!network) continue;

      const own = Object.values(channels)
        .filter((c) => c.network === id)
        .sort((a, b) => byName(a.name, b.name));

      const collapsed = collapsedNetworks[id] ?? false;
      out.push({
        id: `network:${id}`,
        kind: "network",
        network,
        collapsed,
        unread: own.reduce((n, c) => n + c.unread, 0),
        highlights: own.reduce((n, c) => n + c.highlights, 0),
      });
      if (collapsed) continue;

      for (const channel of own) {
        out.push({ id: targetKey(id, channel.name), kind: "channel", channel });
      }
    }

    for (const id of networkOrder) {
      const network = networks[id];
      if (!network) continue;
      const talks = Object.values(queries)
        .filter((q) => q.network === id)
        .sort((a, b) => byName(a.nick, b.nick));
      for (const query of talks) {
        out.push({ id: targetKey(id, query.nick), kind: "query", query, network });
      }
    }

    return out;
  }, [networks, networkOrder, channels, queries, collapsedNetworks]);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The one network row showing its menu; only one is ever open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const tabbableId = rows.some((r) => r.id === focusedId) ? focusedId : rows[0]?.id;
  const firstQuery = rows.findIndex((r) => r.kind === "query");

  function focusRow(index: number) {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setFocusedId(row.id);
    buttons.current.get(row.id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = rows.findIndex((r) => r.id === tabbableId);
    const row = rows[index];
    if (!row) return;

    switch (event.key) {
      case "ArrowDown":
        focusRow(index + 1);
        break;
      case "ArrowUp":
        focusRow(index - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.kind === "network" && row.collapsed) toggleNetworkCollapsed(row.network.id);
        else focusRow(index + 1);
        break;
      case "ArrowLeft":
        if (row.kind === "channel") {
          for (let i = index - 1; i >= 0; i--) {
            if (rows[i]?.kind === "network") {
              focusRow(i);
              break;
            }
          }
        } else if (row.kind === "network" && !row.collapsed) {
          toggleNetworkCollapsed(row.network.id);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  // A network row opens that network's console, which is the first place a
  // person clicks when they want to know what the server said (#80). Collapse
  // moved into the row's own menu.
  function activate(row: Row) {
    if (row.kind === "network") {
      openConsole(row.network.id);
      return;
    }
    const target = row.kind === "channel" ? row.channel.name : row.query.nick;
    const network = row.kind === "channel" ? row.channel.network : row.query.network;
    showTarget({ network, target });
  }

  /** Parts the channel if we are in it, drops it from the sidebar, and takes it
   * out of the set a restart reopens — all of which `close_target` does. The
   * events it sends are what remove the row, so nothing is dropped optimistically
   * and a failure leaves the conversation where it was. */
  async function closeConversation(at: { network: string; target: string }) {
    setMenuFor(null);
    try {
      await ipc.closeTarget(at.network, at.target);
    } catch (reason) {
      // `close_target` answers `Ok` even with no session, so a rejection here is
      // the bridge rather than the conversation.
      console.warn("ircx could not close", at.target, reason);
    }
  }

  function isSelected(row: Row): boolean {
    if (!active) return false;
    if (row.kind === "network") {
      return active.network === row.network.id && active.target === SERVER_TARGET;
    }
    const target = row.kind === "channel" ? row.channel.name : row.query.nick;
    const network = row.kind === "channel" ? row.channel.network : row.query.network;
    return active.network === network && sameTarget(active.target, target);
  }

  function renderRow(row: Row) {
    const selected = isSelected(row);
    const tabbable = row.id === tabbableId;
    const registerButton = (el: HTMLButtonElement | null) => {
      if (el) buttons.current.set(row.id, el);
      else buttons.current.delete(row.id);
    };

    if (row.kind === "network") {
      return (
        <div
          key={row.id}
          className={clsx(
            "group flex items-center",
            selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
          )}
        >
          <NetworkRow
            row={row}
            selected={selected}
            tabbable={tabbable}
            onActivate={() => activate(row)}
            registerButton={registerButton}
          />
          <NetworkMenu
            network={row.network}
            collapsed={row.collapsed}
            resting={selected}
            tabbable={tabbable}
            open={menuFor === row.network.id}
            onOpenChange={(open) => setMenuFor(open ? row.network.id : null)}
            onCollapse={() => toggleNetworkCollapsed(row.network.id)}
            onRawLog={() => openConsole(row.network.id, true)}
            onSettings={() => openSetup(row.network.id)}
          />
        </div>
      );
    }

    const conversation =
      row.kind === "channel"
        ? { network: row.channel.network, target: row.channel.name }
        : { network: row.query.network, target: row.query.nick };

    return (
      <div
        key={row.id}
        className={clsx(
          "group flex items-center",
          selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
        )}
        onContextMenu={(event) => {
          // Right-click opens the same menu the button does, so the two are one
          // affordance rather than two behaviours to keep in step.
          event.preventDefault();
          setMenuFor(row.id);
        }}
      >
        <SidebarRow
          row={row}
          selected={selected}
          tabbable={tabbable}
          onActivate={() => activate(row)}
          registerButton={registerButton}
        />
        <ConversationMenu
          label={row.kind === "channel" ? row.channel.name : row.query.nick}
          leaves={row.kind === "channel"}
          tabbable={tabbable}
          open={menuFor === row.id}
          onOpenChange={(open) => setMenuFor(open ? row.id : null)}
          onClose={() => void closeConversation(conversation)}
        />
      </div>
    );
  }

  return (
    <nav
      aria-label="Networks"
      className="flex h-full min-w-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)]"
    >
      <div className="flex items-center pt-3 pr-1.5">
        <SectionLabel>Networks</SectionLabel>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Add a network"
          title="Add a network"
          onClick={() => openSetup(null)}
          className="rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Icon name="plus" size={12} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-[var(--text-muted)]">
          No networks configured.
        </p>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto pb-2"
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const id = (event.target as HTMLElement).dataset["rowId"];
            if (id) setFocusedId(id);
          }}
        >
          <div role="tree" aria-label="Networks and channels">
            {rows.slice(0, firstQuery === -1 ? rows.length : firstQuery).map(renderRow)}
          </div>

          {firstQuery !== -1 && (
            <>
              <SectionLabel className="pt-4">Queries</SectionLabel>
              <div role="tree" aria-label="Queries">
                {rows.slice(firstQuery).map(renderRow)}
              </div>
            </>
          )}
        </div>
      )}
    </nav>
  );
}

function SectionLabel({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <h2
      className={clsx(
        "px-3 pb-1 text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase",
        className,
      )}
    >
      {children}
    </h2>
  );
}

interface RowProps {
  selected: boolean;
  tabbable: boolean;
  onActivate: () => void;
  registerButton: (el: HTMLButtonElement | null) => void;
}

function NetworkRow({
  row,
  selected,
  tabbable,
  onActivate,
  registerButton,
}: RowProps & { row: Extract<Row, { kind: "network" }> }) {
  return (
    <button
      data-row-id={row.id}
      role="treeitem"
      type="button"
      tabIndex={tabbable ? 0 : -1}
      ref={registerButton}
      onClick={onActivate}
      aria-expanded={!row.collapsed}
      aria-level={1}
      aria-selected={selected}
      aria-label={`${row.network.name}, ${connectionLabel(row.network.status)}`}
      title={`Server messages from ${row.network.name}`}
      className="flex h-8 min-w-0 flex-1 items-center gap-2 px-3 text-[12px] font-medium text-[var(--text-primary)]"
    >
      <StatusDot network={row.network} />
      <span className="truncate">{row.network.name}</span>
      <span className="flex-1" />
      {row.collapsed && row.unread > 0 && (
        <Badge count={row.unread} highlight={row.highlights > 0} />
      )}
    </button>
  );
}

function SidebarRow({
  row,
  selected,
  tabbable,
  onActivate,
  registerButton,
}: RowProps & { row: Exclude<Row, { kind: "network" }> }) {
  const shared = {
    "data-row-id": row.id,
    role: "treeitem",
    type: "button" as const,
    tabIndex: tabbable ? 0 : -1,
    ref: registerButton,
    onClick: onActivate,
  };

  if (row.kind === "query") {
    return (
      <button
        {...shared}
        aria-level={1}
        aria-selected={selected}
        aria-label={row.query.nick}
        className={rowClass(selected)}
      >
        <StatusDot network={row.network} />
        <span className="truncate">{row.query.nick}</span>
        <span className="flex-1" />
        {row.query.unread > 0 && <Badge count={row.query.unread} />}
      </button>
    );
  }

  const name = row.channel.name;
  const restricted = isRestricted(row.channel);

  return (
    <button
      {...shared}
      aria-level={2}
      aria-selected={selected}
      aria-label={restricted ? `${name}, restricted` : name}
      className={rowClass(selected)}
    >
      <span className="flex w-2 shrink-0 justify-center text-[var(--text-faint)]">
        {channelSigil(name)}
      </span>
      <span className="truncate">{stripSigil(name)}</span>
      <span className="flex-1" />
      {restricted && (
        <span className="text-[var(--text-faint)]">
          <Icon name="lock" size={12} />
        </span>
      )}
      {row.channel.unread > 0 && (
        <Badge count={row.channel.unread} highlight={row.channel.highlights > 0} />
      )}
    </button>
  );
}

/**
 * Collapse, the protocol log, and the network's saved settings, all named in
 * words — #80 is a report that none of the three could be found. Hidden until
 * the row is hovered or holds focus, so a sidebar at rest stays the flat list
 * #28 asked for.
 */
function NetworkMenu({
  network,
  collapsed,
  resting,
  tabbable,
  open,
  onOpenChange,
  onCollapse,
  onRawLog,
  onSettings,
}: {
  network: Network;
  collapsed: boolean;
  /** Drawn without a hover, because this network's console is the one on show. */
  resting: boolean;
  tabbable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCollapse: () => void;
  onRawLog: () => void;
  onSettings: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);

  const choose = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          onOpenChange(false);
          button.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          // The tree owns the arrow keys everywhere else in the sidebar; while
          // the menu is open they belong to it.
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ];
          const down = event.key === "ArrowDown";
          const at = items.indexOf(document.activeElement as HTMLElement);
          // From the button itself, down starts at the first item, up at the last.
          const next = at === -1 ? (down ? 0 : -1) : at + (down ? 1 : -1);
          items[((next % items.length) + items.length) % items.length]?.focus();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={`${network.name} actions`}
        title={`${network.name} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onOpenChange(!open)}
        className={clsx(
          "mr-1.5 rounded-[var(--radius-sm)] p-1",
          open ? "text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
          open || resting ? "block" : "hidden group-hover:block group-focus-within:block",
        )}
      >
        <OverflowIcon size={12} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${network.name} actions`}
          className="absolute top-full right-0 z-10 mt-1 w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
        >
          <MenuItem onClick={choose(onCollapse)}>
            {collapsed ? "Show channels" : "Hide channels"}
          </MenuItem>
          <MenuItem onClick={choose(onRawLog)}>Raw protocol log</MenuItem>
          <MenuItem onClick={choose(onSettings)}>{network.name} settings</MenuItem>
        </div>
      )}
    </div>
  );
}

/**
 * What can be done to one conversation. Only closing, for now, which is what
 * #121 found missing: `close_target` was reachable from nowhere, so a channel
 * joined once stayed in the sidebar and came back on the next launch.
 *
 * Hidden until the row is hovered or holds focus, like the network row's menu
 * and for the reason #80 gave — a sidebar at rest is the flat list #28 asked
 * for, and an action nobody can find is not an action.
 */
function ConversationMenu({
  label,
  leaves,
  tabbable,
  open,
  onOpenChange,
  onClose,
}: {
  label: string;
  /** A channel is parted when it closes, which everyone in it sees. A query is
   * closed privately, so the two do not read the same. */
  leaves: boolean;
  tabbable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          onOpenChange(false);
          button.current?.focus();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={`${label} actions`}
        title={`${label} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onOpenChange(!open)}
        className={clsx(
          "mr-1.5 rounded-[var(--radius-sm)] p-1",
          open
            ? "text-[var(--accent)]"
            : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
          open ? "block" : "hidden group-hover:block group-focus-within:block",
        )}
      >
        <OverflowIcon size={12} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${label} actions`}
          className="absolute top-full right-0 z-10 mt-1 w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
        >
          <MenuItem onClick={onClose}>{leaves ? "Leave and close" : "Close"}</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full truncate rounded-[var(--radius-sm)] px-2 py-1 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}

function rowClass(selected: boolean): string {
  return clsx(
    "flex h-7 w-full items-center gap-2 px-3 text-[12px]",
    selected
      ? "bg-[var(--surface-active)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
  );
}

function StatusDot({ network }: { network: Network }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: connectionColor(network.status) }}
    />
  );
}

function channelSigil(name: string): string {
  return name.startsWith("&") ? "&" : "#";
}

function stripSigil(name: string): string {
  return /^[#&+!]/.test(name) ? name.slice(1) : name;
}
