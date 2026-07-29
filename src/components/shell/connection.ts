import { useAppStore } from "@/store";
import type { ConnectionStatus, Network } from "@/types";

/** The network the window chrome and status bar describe: whichever one the
 * active target belongs to, falling back to the first in sidebar order. */
export function useDisplayedNetwork(): Network | undefined {
  return useAppStore((s) => {
    const id = s.active?.network ?? s.networkOrder[0];
    return id ? s.networks[id] : undefined;
  });
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
