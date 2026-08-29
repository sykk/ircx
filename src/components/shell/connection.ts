import { useAppStore } from "@/store";
import { useActiveTarget, useNetwork } from "@/store/selectors";
import type { ConnectionStatus, Network } from "@/types";

/** The network the window chrome and status bar describe: whichever one the
 * active target belongs to, falling back to the first in sidebar order. */
export function useDisplayedNetwork(): Network | undefined {
  const active = useActiveTarget();
  const first = useAppStore((s) => s.networkOrder[0]);
  return useNetwork(active?.network ?? first);
}

const CONNECTION_PRIORITY: Record<ConnectionStatus["state"], number> = {
  connected: 0,
  connecting: 1,
  registering: 1,
  disconnected: 2,
  reconnecting: 3,
  failed: 4,
};

export function worstConnectionStatus(networks: readonly Network[]): ConnectionStatus | undefined {
  return networks.reduce<ConnectionStatus | undefined>((worst, network) => {
    if (worst === undefined) return network.status;
    return CONNECTION_PRIORITY[network.status.state] > CONNECTION_PRIORITY[worst.state]
      ? network.status
      : worst;
  }, undefined);
}

export function problemNetworks(networks: readonly Network[]): Network[] {
  return networks.filter(
    (network) => network.status.state === "failed" || network.status.state === "reconnecting",
  );
}

export function connectionColor(status: ConnectionStatus): string {
  switch (status.state) {
    case "connected":
      return "var(--state-connected)";
    case "connecting":
    case "registering":
    case "reconnecting":
      return "var(--state-connecting)";
    case "failed":
      return "var(--state-error)";
    case "disconnected":
      return "var(--state-disconnected)";
  }
}

export function connectionLabel(status: ConnectionStatus): string {
  switch (status.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "registering":
      return "Registering";
    case "reconnecting":
      return "Reconnecting";
    case "failed":
      return "Connection failed";
    case "disconnected":
      return "Disconnected";
  }
}

export function connectionDetail(status: ConnectionStatus): string | null {
  switch (status.state) {
    case "reconnecting":
      return `Retry in ${status.detail.inSeconds}s`;
    case "failed":
      return `Retry failed: ${status.detail.message}`;
    default:
      return null;
  }
}
