import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Badge } from "@/components/common/Badge";
import { Icon } from "@/components/common/Icon";
import { useAppStore } from "@/store";
import { sameTarget, targetKey } from "@/store/keys";
import type { Channel, Network, Query } from "@/types";
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
  const active = useAppStore((s) => s.active);
  const setActive = useAppStore((s) => s.setActive);
  const toggleNetworkCollapsed = useAppStore((s) => s.toggleNetworkCollapsed);

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

  function activate(row: Row) {
    if (row.kind === "network") {
      toggleNetworkCollapsed(row.network.id);
      return;
    }
    const target = row.kind === "channel" ? row.channel.name : row.query.nick;
    const network = row.kind === "channel" ? row.channel.network : row.query.network;
    setActive({ network, target });
  }

  function isSelected(row: Row): boolean {
    if (!active || row.kind === "network") return false;
    const target = row.kind === "channel" ? row.channel.name : row.query.nick;
    const network = row.kind === "channel" ? row.channel.network : row.query.network;
    return active.network === network && sameTarget(active.target, target);
  }

  function renderRow(row: Row) {
    return (
      <SidebarRow
        key={row.id}
        row={row}
        selected={isSelected(row)}
        tabbable={row.id === tabbableId}
        onActivate={() => activate(row)}
        registerButton={(el) => {
          if (el) buttons.current.set(row.id, el);
          else buttons.current.delete(row.id);
        }}
      />
    );
  }

  return (
    <nav
      aria-label="Networks"
      className="flex h-full min-w-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)]"
    >
      <SectionLabel className="pt-3">Networks</SectionLabel>

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

function SidebarRow({
  row,
  selected,
  tabbable,
  onActivate,
  registerButton,
}: {
  row: Row;
  selected: boolean;
  tabbable: boolean;
  onActivate: () => void;
  registerButton: (el: HTMLButtonElement | null) => void;
}) {
  const shared = {
    "data-row-id": row.id,
    role: "treeitem",
    type: "button" as const,
    tabIndex: tabbable ? 0 : -1,
    ref: registerButton,
    onClick: onActivate,
  };

  if (row.kind === "network") {
    return (
      <button
        {...shared}
        aria-expanded={!row.collapsed}
        aria-level={1}
        aria-label={`${row.network.name}, ${connectionLabel(row.network.status)}`}
        className="flex h-8 w-full items-center gap-2 px-3 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
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
