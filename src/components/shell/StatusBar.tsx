import { useEffect, useState, type ReactNode } from "react";
import { Tooltip } from "@/components/common/Tooltip";
import { pluginStatus } from "@/components/plugins";
import { useAppStore } from "@/store";
import type { ConnectionStatus, Network, SaslStatus } from "@/types";
import { connectionColor, useDisplayedNetwork } from "./connection";

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
  const seconds = useReconnectSeconds(network?.status ?? { state: "disconnected" });

  return (
    <footer
      aria-label="Connection status"
      className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-[var(--border-subtle)] bg-[var(--surface-sidebar)] px-3 text-[11px] text-[var(--text-secondary)]"
    >
      {network ? (
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: connectionColor(network.status) }}
          />
          <span className="truncate">
            <ConnectionSummary network={network} seconds={seconds} />
          </span>
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
        <Plugins />
      </span>
    </footer>
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
        <>
          Connected to {where}{" "}
          {network.tls ? (
            <span className="text-[var(--text-muted)]">(TLS)</span>
          ) : (
            <span className="text-[var(--warning)]">(no TLS)</span>
          )}
        </>
      );
    case "connecting":
      return <>Connecting to {where}</>;
    case "registering":
      return <>Registering with {where}</>;
    case "reconnecting":
      return <>Reconnecting to {where} in {seconds ?? 0}s</>;
    // The bar gives the whole connection one truncated line, and the sentences
    // core writes are long enough to be cut mid-word in it — which reports a
    // failure by showing the first half of why. It says which network failed
    // and leaves the reason to the two places that have room for it: the setup
    // screen, and the server buffer every failure is noted into.
    case "failed":
      return <span className="text-[var(--danger)]">{where} failed</span>;
    case "disconnected":
      return <span className="text-[var(--text-muted)]">Not connected to {where}</span>;
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
        Caps {caps.length}
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

  return (
    <Tooltip label={detail} placement="top">
      <span tabIndex={0} aria-label={`${text}: ${detail}`} className="tabular-nums">
        {text}
      </span>
    </Tooltip>
  );
}

function Sasl({ status }: { status: SaslStatus }) {
  const [text, color, detail] = saslDisplay(status);

  return (
    <Tooltip label={detail} placement="top">
      <span tabIndex={0} aria-label={detail} className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
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
 */
function saslDisplay(status: SaslStatus): [string, string, string] {
  switch (status.state) {
    case "authenticated":
      return [
        `signed in as ${status.detail.account}`,
        "var(--state-connected)",
        `Authenticated as ${status.detail.account}`,
      ];
    case "inProgress":
      return ["signing in", "var(--state-connecting)", "Authenticating"];
    case "failed":
      return ["not signed in", "var(--state-error)", `SASL failed: ${status.detail.message}`];
    // Nothing failed and nothing is signed in: the user did not ask to be.
    // Saying "not signed in" here would report an absence as a fault.
    case "notConfigured":
      return ["no account", "var(--state-disconnected)", "SASL is not configured"];
  }
}
