import { useEffect, useState, type ReactNode } from "react";
import { Tooltip } from "@/components/common/Tooltip";
import { pluginStatus } from "@/components/plugins";
import { TransfersStatus } from "@/components/transfers/TransfersPanel";
import { useAppStore } from "@/store";
import { useNetworks } from "@/store/selectors";
import type { ConnectionStatus, Network, SaslStatus } from "@/types";
import { connectionColor, problemNetworks, useDisplayedNetwork } from "./connection";

// Mirrors `ircx_core::caps::SUPPORTED`, the set this count is measured against.
const SUPPORTED_CAPABILITY_COUNT = 20;

/** The backend reports the delay once per attempt, so the seconds are counted
 * down here and restarted whenever a new figure arrives. */
function useReconnectSeconds(status: ConnectionStatus): number | null {
  const reported = status.state === "reconnecting" ? status.detail.inSeconds : null;
  const [elapsed, setElapsed] = useState(0);
  const [counting, setCounting] = useState(reported);

  if (counting !== reported) {
    setCounting(reported);
    setElapsed(0);
  }

  useEffect(() => {
    if (reported === null) return;
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [reported]);

  return reported === null ? null : Math.max(0, reported - elapsed);
}

export function StatusBar() {
  const network = useDisplayedNetwork();
  const networks = useNetworks();
  const otherProblems = problemNetworks(networks).filter(({ id }) => id !== network?.id);
  const seconds = useReconnectSeconds(network?.status ?? { state: "disconnected" });

  return (
    <footer
      aria-label="Connection status"
      data-ui="statusbar"
      className="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-[var(--border-subtle)] bg-[var(--surface-sidebar)] px-3 text-[10px] text-[var(--text-muted)]"
    >
      {network ? (
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: connectionColor(network.status) }}
          />
          <ConnectionSummary network={network} seconds={seconds} />
          <NetworkProblems networks={otherProblems} />
        </span>
      ) : (
        <span className="text-[var(--text-muted)]">No network</span>
      )}

      {/* Plugins belong to the client rather than to a connection, so they are
          reported whether or not one is up. */}
      <span className="flex shrink-0 items-center gap-3">
        {network && (
          <>
            <span className="tabular-nums">
              Lag {network.lagMs === null ? "—" : `${network.lagMs}ms`}
            </span>
            <Capabilities caps={network.capsEnabled} />
            <Sasl status={network.sasl} />
          </>
        )}
        <TransfersStatus />
        <Plugins />
      </span>
    </footer>
  );
}

function NetworkProblems({ networks }: { networks: Network[] }) {
  if (networks.length === 0) return null;
  const first = networks[0]!;
  const visible =
    first.status.state === "failed"
      ? `${first.host} failed`
      : `${first.host} reconnecting`;
  const detail = networks
    .map((network) => {
      if (network.status.state === "failed") {
        return `${network.name}: ${network.status.detail.message}`;
      }
      if (network.status.state === "reconnecting") {
        return `${network.name}: retrying in ${network.status.detail.inSeconds}s`;
      }
      return network.name;
    })
    .join("; ");

  return (
    <Tooltip label={detail} placement="top">
      <span
        tabIndex={0}
        className="shrink-0"
        style={{ color: connectionColor(first.status) }}
        aria-label={`Other network problems: ${detail}`}
      >
        · {visible}
        {networks.length > 1 ? ` +${networks.length - 1}` : ""}
      </span>
    </Tooltip>
  );
}

function ConnectionSummary({
  network,
  seconds,
}: {
  network: Network;
  seconds: number | null;
}): ReactNode {
  const where = `${network.host}:${network.port}`;

  switch (network.status.state) {
    case "connected":
      return (
        <span className="truncate">
          Connected to {where}{" "}
          {network.tls ? (
            <span className="text-[var(--text-muted)]">(TLS)</span>
          ) : (
            <span className="text-[var(--warning)]">(no TLS)</span>
          )}
        </span>
      );
    case "connecting":
      return <span className="truncate">Connecting to {where}</span>;
    case "registering":
      return <span className="truncate">Registering with {where}</span>;
    case "reconnecting":
      return <span className="truncate">Reconnecting to {where} in {seconds ?? 0}s</span>;
    // The sentences core writes are longer than this line, so the summary says
    // which network failed and the tooltip holds why — the same shape as every
    // other item in the bar. It cannot be truncated like its neighbours: the
    // overflow that clips a long line clips the tooltip with it.
    case "failed":
      return (
        <Tooltip label={network.status.detail.message} placement="top">
          <span
            tabIndex={0}
            aria-label={`${where} failed: ${network.status.detail.message}`}
            className="text-[var(--danger)]"
          >
            {where} failed
          </span>
        </Tooltip>
      );
    case "disconnected":
      return (
        <span className="truncate text-[var(--text-muted)]">Not connected to {where}</span>
      );
  }
}

function Capabilities({ caps }: { caps: string[] }) {
  const detail =
    caps.length === 0
      ? "No capabilities negotiated"
      : [...caps].sort().join(", ");

  return (
    <Tooltip label={detail} placement="top">
      <span tabIndex={0} aria-label={`Capabilities: ${detail}`} className="tabular-nums">
        Caps {caps.length}/{SUPPORTED_CAPABILITY_COUNT}
      </span>
    </Tooltip>
  );
}

/** Installed is not the same as usable: a plugin the user cannot invoke does
 * nothing, so the count says how many of them can be reached. */
function Plugins() {
  const plugins = useAppStore((s) => s.plugins);
  const unavailable = useAppStore((s) => s.pluginsUnavailable);
  const { text, detail } = pluginStatus(plugins);

  // A library that would not open is not an empty one. Saying "Plugins 0" here
  // would hide every plugin the user has behind a number that reads as fine.
  if (unavailable !== null) {
    return (
      <Tooltip label={unavailable} placement="top">
        <span
          tabIndex={0}
          aria-label={`Plugins unavailable: ${unavailable}`}
          className="text-[var(--warning)]"
        >
          Plugins —
        </span>
      </Tooltip>
    );
  }

  if (plugins.length === 0) return null;

  return (
    <Tooltip label={detail} placement="top">
      <span tabIndex={0} aria-label={`${text}: ${detail}`} className="tabular-nums">
        {text}
      </span>
    </Tooltip>
  );
}

function Sasl({ status }: { status: SaslStatus }) {
  const [text, detail] = saslDisplay(status);

  return (
    <Tooltip label={detail} placement="top">
      <span tabIndex={0} aria-label={detail}>
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * What the indicator says, which is the state rather than the name of the
 * mechanism that produces it.
 *
 * It read `SASL` in all four states, and the only thing separating "signed in
 * as syk" from "not signed in at all" was the colour of the dot and a tooltip
 * somebody had to hover. A connection that succeeds without logging you in
 * looks exactly like one that does — which is how a mechanism the server never
 * offered got read as a successful login twice in one afternoon.
 *
 * The same argument the timeline makes about a mention: a colour says the
 * client noticed something and cannot say what it noticed.
 *
 * An authenticated label still names the account under a refusal because the
 * account is real. The tooltip carries the half the reader can act on.
 */
function saslDisplay(status: SaslStatus): [string, string] {
  switch (status.state) {
    case "authenticated": {
      const { account, refused } = status.detail;
      return [
        `signed in as ${account}`,
        refused === null
          ? `Authenticated as ${account}`
          : `Signed in as ${account}. ${refused}`,
      ];
    }
    case "inProgress":
      return ["signing in", "Authenticating"];
    case "failed":
      return ["not signed in", `SASL failed: ${status.detail.message}`];
    // Nothing failed and nothing is signed in: the user did not ask to be.
    // Saying "not signed in" here would report an absence as a fault.
    case "notConfigured":
      return ["no account", "SASL is not configured"];
  }
}
