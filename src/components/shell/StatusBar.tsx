import { useEffect, useState, type ReactNode } from "react";
import { Tooltip } from "@/components/common/Tooltip";
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
        <>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: connectionColor(network.status) }}
            />
            <span className="truncate">
              <ConnectionSummary network={network} seconds={seconds} />
            </span>
          </span>

          <span className="flex shrink-0 items-center gap-3">
            <span className="tabular-nums">
              Lag {network.lagMs === null ? "—" : `${network.lagMs}ms`}
            </span>
            <Capabilities caps={network.capsEnabled} />
            <Sasl status={network.sasl} />
          </span>
        </>
      ) : (
        <span className="text-[var(--text-muted)]">No network</span>
      )}
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
    case "failed":
      return (
        <span className="text-[var(--danger)]">
          {where} failed: {network.status.detail.message}
        </span>
      );
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

function saslDisplay(status: SaslStatus): [string, string, string] {
  switch (status.state) {
    case "authenticated":
      return [
        "SASL",
        "var(--state-connected)",
        `Authenticated as ${status.detail.account}`,
      ];
    case "inProgress":
      return ["SASL", "var(--state-connecting)", "Authenticating"];
    case "failed":
      return ["SASL", "var(--state-error)", `SASL failed: ${status.detail.message}`];
    case "notConfigured":
      return ["SASL", "var(--state-disconnected)", "SASL is not configured"];
  }
}
