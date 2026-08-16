import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Badge } from "@/components/common/Badge";
import { ipc } from "@/lib/ipc";
import { Icon } from "@/components/common/Icon";
import { useHangingMenu } from "@/components/common/hangingMenu";
import { OverflowIcon } from "@/components/header/icons";
import { useAppStore } from "@/store";
import { sameTarget, targetKey, type TargetKey } from "@/store/keys";
import { useActiveTarget } from "@/store/selectors";
import { SERVER_TARGET, type Channel, type Network, type Query } from "@/types";
import { connectionColor, connectionDetail, connectionLabel } from "./connection";

type Row =
  | {
      id: string;
      kind: "network";
      network: Network;
      collapsed: boolean;
      unread: number;
      draft: boolean;
      attention: number;
    }
  | {
      id: TargetKey;
      kind: "channel";
      channel: Channel;
      draft: boolean;
      pinned: boolean;
    }
  | { id: TargetKey; kind: "query"; query: Query; draft: boolean; pinned: boolean };

/** One network's panel: the server's own row and every conversation on it.
 * Two networks both hosting a NickServ is what the flat list could not draw —
 * the queries section gathered every network's into one place, so two rows read
 * the same and neither said which server it was with. */
interface Panel {
  header: Extract<Row, { kind: "network" }>;
  channels: Extract<Row, { kind: "channel" }>[];
  queries: Extract<Row, { kind: "query" }>[];
}

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
  const drafts = useAppStore((s) => s.drafts);
  const collapsedNetworks = useAppStore((s) => s.collapsedNetworks);
  const compact = useAppStore((s) => s.sidebarCompact);
  const pinnedTargets = useAppStore((s) => s.pinnedTargets);
  const active = useActiveTarget();
  const showTarget = useAppStore((s) => s.showTarget);
  const openConsole = useAppStore((s) => s.openConsole);
  const toggleNetworkCollapsed = useAppStore((s) => s.toggleNetworkCollapsed);
  const openSetup = useAppStore((s) => s.openSetup);
  const togglePinnedTarget = useAppStore((s) => s.togglePinnedTarget);

  // The store's list selectors build a fresh array per call, which React's
  // useSyncExternalStore treats as a changed snapshot; deriving here keeps the
  // subscriptions on the stable record objects.
  const panels = useMemo<Panel[]>(() => {
    const out: Panel[] = [];
    const pinned = new Set(pinnedTargets);
    for (const id of networkOrder) {
      const network = networks[id];
      if (!network) continue;

      const own = Object.values(channels)
        .filter((c) => c.network === id)
        .sort((a, b) => {
          const aPinned = pinned.has(targetKey(id, a.name));
          const bPinned = pinned.has(targetKey(id, b.name));
          return Number(bPinned) - Number(aPinned) || byName(a.name, b.name);
        });
      const talks = Object.values(queries)
        .filter((q) => q.network === id)
        .sort((a, b) => {
          const aPinned = pinned.has(targetKey(id, a.nick));
          const bPinned = pinned.has(targetKey(id, b.nick));
          return Number(bPinned) - Number(aPinned) || byName(a.nick, b.nick);
        });

      out.push({
        header: {
          id: `network:${id}`,
          kind: "network",
          network,
          collapsed: collapsedNetworks[id] ?? false,
          // A collapsed panel hides its queries with its channels, so the count
          // on the row has to answer for both.
          unread:
            own.reduce((n, c) => n + c.unread, 0) + talks.reduce((n, q) => n + q.unread, 0),
          draft: [...own, ...talks].some((target) =>
            Boolean(drafts[targetKey(id, "name" in target ? target.name : target.nick)]),
          ),
          attention:
            own.reduce((n, c) => n + c.highlights, 0) +
            talks.reduce((n, q) => n + q.unread, 0),
        },
        channels: own.map((channel) => ({
          id: targetKey(id, channel.name),
          kind: "channel" as const,
          channel,
          draft: Boolean(drafts[targetKey(id, channel.name)]),
          pinned: pinned.has(targetKey(id, channel.name)),
        })),
        queries: talks.map((query) => ({
          id: targetKey(id, query.nick),
          kind: "query" as const,
          query,
          draft: Boolean(drafts[targetKey(id, query.nick)]),
          pinned: pinned.has(targetKey(id, query.nick)),
        })),
      });
    }
    return out;
  }, [networks, networkOrder, channels, queries, drafts, collapsedNetworks, pinnedTargets]);

  /** The panels flattened into what the arrow keys walk. */
  const rows = useMemo<Row[]>(
    () =>
      panels.flatMap((panel) =>
        panel.header.collapsed
          ? [panel.header]
          : [panel.header, ...panel.channels, ...panel.queries],
      ),
    [panels],
  );

  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The one network row showing its menu; only one is ever open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const tabbableId = rows.some((r) => r.id === focusedId) ? focusedId : rows[0]?.id;

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
        if (row.kind !== "network") {
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
      console.warn("ircx could not close", at.target, reason);
    }
  }

  /** Drops the network from the sidebar and disconnects it when it is running. */
  async function removeNetwork(network: Network) {
    try {
      await ipc.removeNetwork(network.id);
    } catch (reason) {
      console.warn("ircx could not remove", network.name, reason);
    }
  }

  /** Stops a network, or starts one that is stopped. A network that keeps
   * failing is retrying, so what somebody reaching for this wants is the loop
   * to end — `disconnect` is tolerant of a handle that has already gone. */
  async function toggleConnection(network: Network) {
    setMenuFor(null);
    const running = network.status.state !== "disconnected";
    try {
      await (running ? ipc.disconnectNetwork(network.id) : ipc.connectNetwork(network.id));
    } catch (reason) {
      console.warn("ircx could not change", network.name, reason);
    }
  }

  async function reconnect(network: Network) {
    setMenuFor(null);
    try {
      await ipc.disconnectNetwork(network.id);
      await ipc.connectNetwork(network.id);
    } catch (reason) {
      console.warn("ircx could not reconnect", network.name, reason);
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
            !selected && "hover:bg-[var(--surface-hover)]",
          )}
        >
          <NetworkRow
            row={row}
            selected={selected}
            tabbable={tabbable}
            onActivate={() => activate(row)}
            registerButton={registerButton}
            compact={compact}
          />
          <NetworkMenu
            network={row.network}
            collapsed={row.collapsed}
            resting={selected}
            tabbable={tabbable}
            open={menuFor === row.network.id}
            onOpenChange={(open) => setMenuFor(open ? row.network.id : null)}
            onCollapse={() => toggleNetworkCollapsed(row.network.id)}
            onConnection={() => void toggleConnection(row.network)}
            onReconnect={() => void reconnect(row.network)}
            onRawLog={() => openConsole(row.network.id, true)}
            onSettings={() => openSetup(row.network.id)}
          />
          <CloseButton
            label={`Remove ${row.network.name}`}
            tabbable={tabbable}
            visible={selected}
            onClose={() => void removeNetwork(row.network)}
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
          "group relative flex items-center",
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
          compact={compact}
        />
        <CloseButton
          label={
            row.kind === "channel"
              ? `Leave and close ${row.channel.name}`
              : `Close ${row.query.nick}`
          }
          tabbable={tabbable}
          visible={selected}
          onClose={() => void closeConversation(conversation)}
        />
        <ConversationMenu
          label={row.kind === "channel" ? row.channel.name : row.query.nick}
          leaves={row.kind === "channel"}
          pinned={row.pinned}
          open={menuFor === row.id}
          onOpenChange={(open) => setMenuFor(open ? row.id : null)}
          onTogglePinned={() => togglePinnedTarget(row.id)}
          onClose={() => void closeConversation(conversation)}
        />
      </div>
    );
  }

  return (
    <nav
      aria-label="Networks"
      data-ui="sidebar"
      className="flex h-full min-w-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)]"
    >
      <div className={clsx("flex items-center pr-1.5", compact ? "pt-2" : "pt-3")}>
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
          <div role="tree" aria-label="Networks and conversations">
            {panels.map((panel) => (
              <div
                key={panel.header.id}
                role="none"
                className={compact ? "mb-0" : "mb-1"}
              >
                {renderRow(panel.header)}
                {!panel.header.collapsed && (
                  <div role="group" aria-label={panel.header.network.name}>
                    {panel.channels.map(renderRow)}
                    {panel.channels.length > 0 && panel.queries.length > 0 && (
                      <div
                        className={clsx(
                          "mx-3 border-t border-[var(--border-subtle)]",
                          compact ? "my-0.5" : "my-1",
                        )}
                      />
                    )}
                    {panel.queries.map(renderRow)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="px-3 pb-1 text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase">
      {children}
    </h2>
  );
}

interface RowProps {
  selected: boolean;
  tabbable: boolean;
  onActivate: () => void;
  registerButton: (el: HTMLButtonElement | null) => void;
  compact: boolean;
}

function NetworkRow({
  row,
  selected,
  tabbable,
  onActivate,
  registerButton,
  compact,
}: RowProps & { row: Extract<Row, { kind: "network" }> }) {
  const detail = connectionDetail(row.network.status);
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
      aria-label={`${row.network.name}, ${connectionLabel(row.network.status)}${detail ? `, ${detail}` : ""}`}
      title={`Server messages from ${row.network.name}`}
      className={clsx(
        "flex min-w-0 flex-1 items-center gap-2 px-3 text-[12px] font-medium text-[var(--text-primary)]",
        compact ? "h-6" : "h-8",
      )}
    >
      <StatusDot network={row.network} />
      <span className="truncate">{row.network.name}</span>
      {detail && (
        <span
          className={clsx(
            "min-w-0 truncate text-[10px] font-normal",
            row.network.status.state === "failed"
              ? "text-[var(--danger)]"
              : "text-[var(--text-muted)]",
          )}
        >
          {detail}
        </span>
      )}
      <span className="flex-1" />
      {row.collapsed && row.draft && <DraftMark />}
      {row.collapsed && row.attention > 0 && <Badge count={row.attention} highlight />}
      {row.collapsed && row.attention === 0 && row.unread > 0 && (
        <UnreadMark count={row.unread} />
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
  compact,
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
        aria-level={2}
        aria-selected={selected}
        aria-label={`${row.query.nick}${row.query.online ? "" : ", offline"}${row.draft ? ", draft" : ""}${row.pinned ? ", pinned" : ""}`}
        className={rowClass(selected, compact)}
      >
        {/* Where a channel draws its sigil, a query draws whether the other
            person is there — the network's own dot belonged here only while
            queries were listed away from the network they are on. */}
        <Dot
          color={row.query.online ? "var(--state-connected)" : "var(--state-disconnected)"}
        />
        {/* Quieter rather than badged. `online` is false only because a quit
            was seen and nothing has been heard since. */}
        <span
          className="truncate"
          style={row.query.online ? undefined : { color: "var(--text-muted)" }}
        >
          {row.query.nick}
        </span>
        <span className="flex-1" />
        {row.draft && <DraftMark />}
        {row.pinned && <PinnedMark />}
        {row.query.muted && <MutedMark />}
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
      aria-label={`${name}${restricted ? ", restricted" : ""}${row.draft ? ", draft" : ""}${row.pinned ? ", pinned" : ""}`}
      className={rowClass(selected, compact)}
    >
      <span className="flex w-2 shrink-0 justify-center text-[var(--text-faint)]">
        {channelSigil(name)}
      </span>
      <span className="truncate">{stripSigil(name)}</span>
      <span className="flex-1" />
      {row.draft && <DraftMark />}
      {row.pinned && <PinnedMark />}
      {restricted && (
        <span className="text-[var(--text-faint)]">
          <Icon name="lock" size={12} />
        </span>
      )}
      {row.channel.muted && <MutedMark />}
      {row.channel.highlights > 0 && <Badge count={row.channel.highlights} highlight />}
      {row.channel.highlights === 0 && row.channel.unread > 0 && (
        <UnreadMark count={row.channel.unread} />
      )}
    </button>
  );
}

function DraftMark() {
  return (
    <span className="text-[var(--text-faint)]" title="Unsent draft" aria-label="Draft" role="img">
      <Icon name="draft" size={12} />
    </span>
  );
}

function PinnedMark() {
  return (
    <span className="text-[var(--text-faint)]" title="Pinned" aria-label="Pinned" role="img">
      <Icon name="pin" size={12} />
    </span>
  );
}

/**
 * Why a conversation is quiet, where somebody would go looking for it.
 *
 * The row is the answer to "why did this not go loud", and the settings window
 * only knows the conversation the client happened to be on when it opened. A
 * mute nobody can find is worse than no mute: the channel is simply broken.
 *
 * Beside the lock rather than instead of the badge — the count still rises, and
 * a muted conversation with unread messages has both things to say.
 */
function MutedMark() {
  return (
    <span className="text-[var(--text-faint)]" title="Muted" aria-label="Muted" role="img">
      <Icon name="bellOff" size={12} />
    </span>
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
  onConnection,
  onReconnect,
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
  onConnection: () => void;
  onReconnect: () => void;
  onRawLog: () => void;
  onSettings: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  /** Stable, because the placing effect takes it as a dependency. */
  const anchorToButton = useCallback(() => button.current, []);
  const menu = useHangingMenu(open, anchorToButton);

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
          ref={menu}
          role="menu"
          aria-label={`${network.name} actions`}
          className="fixed z-[100] w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
        >
          <MenuItem onClick={choose(onCollapse)}>
            {collapsed ? "Show conversations" : "Hide conversations"}
          </MenuItem>
          <MenuItem onClick={choose(onConnection)}>
            {network.status.state === "disconnected" ? "Connect" : "Disconnect"}
          </MenuItem>
          {(network.status.state === "failed" || network.status.state === "reconnecting") && (
            <MenuItem onClick={choose(onReconnect)}>Reconnect now</MenuItem>
          )}
          <MenuItem onClick={choose(onRawLog)}>Raw protocol log</MenuItem>
          <MenuItem onClick={choose(onSettings)}>{network.name} settings</MenuItem>
        </div>
      )}
    </div>
  );
}

/**
 * Closes a conversation or removes a network. Shown on hover and when the row
 * is selected, like the network row's overflow menu.
 */
function CloseButton({
  label,
  tabbable,
  visible,
  onClose,
}: {
  label: string;
  tabbable: boolean;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={tabbable ? 0 : -1}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      className={clsx(
        "mr-1.5 rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        visible ? "block" : "hidden group-hover:block group-focus-within:block",
      )}
    >
      <Icon name="close" size={12} />
    </button>
  );
}

/** Hoisted so its identity is stable: an arrow written at the call site is a
 * new function every render, and the placing effect takes it as a dependency. */
const anchorToRow = (menu: HTMLElement) => menu.parentElement;

/**
 * What can be done to one conversation beyond the ×. Only closing, for now.
 * Reached from a right-click; the × is the direct route #121 asked for.
 */
function ConversationMenu({
  label,
  leaves,
  pinned,
  open,
  onOpenChange,
  onTogglePinned,
  onClose,
}: {
  label: string;
  /** A channel is parted when it closes, which everyone in it sees. A query is
   * closed privately, so the two do not read the same. */
  leaves: boolean;
  pinned: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTogglePinned: () => void;
  onClose: () => void;
}) {
  /* The row this was right-clicked on, which is the menu's own parent and the
   * full width of the sidebar. Called before the early return below, hooks
   * being hooks. */
  const menu = useHangingMenu(open, anchorToRow);

  if (!open) return null;

  const close = () => {
    onOpenChange(false);
    onClose();
  };

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={`${label} actions`}
      className="fixed z-[100] w-44 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onOpenChange(false);
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <MenuItem
        onClick={() => {
          onOpenChange(false);
          onTogglePinned();
        }}
      >
        {pinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuItem onClick={close}>{leaves ? "Leave and close" : "Close"}</MenuItem>
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

function rowClass(selected: boolean, compact: boolean): string {
  return clsx(
    "flex w-full items-center gap-2 rounded-[var(--radius-sm)] pr-3 pl-5 text-[12px]",
    compact ? "h-6" : "h-7",
    selected
      ? "bg-[var(--surface-active)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
  );
}

function StatusDot({ network }: { network: Network }) {
  return <Dot color={connectionColor(network.status)} />;
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

function UnreadMark({ count }: { count: number }) {
  const label = `${count} unread message${count === 1 ? "" : "s"}`;
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

function channelSigil(name: string): string {
  return name.startsWith("&") ? "&" : "#";
}

function stripSigil(name: string): string {
  return /^[#&+!]/.test(name) ? name.slice(1) : name;
}
