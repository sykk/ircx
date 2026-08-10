import { useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/onboarding/fields";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { connectionColor, connectionLabel } from "@/components/shell/connection";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ipc, reasonOr } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { useNetworks } from "@/store/selectors";
import type { Network } from "@/types";

/**
 * Every configured network, what each one is doing, and the four things that
 * can be done to it: add another, stop or start one, change its settings,
 * remove it.
 *
 * Read out of the store rather than from `list_network_configs`, which is what
 * the form reads. The store's networks carry the connection state, and a page
 * that lists connections and cannot see them change would be a worse list than
 * the sidebar's.
 */
export function NetworkList({ onDone }: { onDone: () => void }) {
  const networks = useNetworks();
  const openSetup = useAppStore((s) => s.openSetup);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);

  /** Stops a network, or starts one that is stopped. A network that keeps
   * failing is retrying, so what somebody reaching for this wants is the loop
   * to end — `disconnect` is tolerant of a handle that has already gone. */
  async function toggleConnection(network: Network) {
    setError(null);
    const running = network.status.state !== "disconnected";
    try {
      await (running ? ipc.disconnectNetwork(network.id) : ipc.connectNetwork(network.id));
    } catch (reason) {
      setError(
        reasonOr(reason, `${network.name} could not be ${running ? "stopped" : "started"}.`),
      );
    }
  }

  async function remove(network: Network) {
    setError(null);
    setConfirming(null);
    try {
      await ipc.removeNetwork(network.id);
    } catch (reason) {
      setError(reasonOr(reason, `${network.name} could not be removed.`));
    }
  }

  return (
    <SettingsPage
      title="Networks"
      blurb="The servers this client connects to. Removing one disconnects it and forgets its settings."
      onDone={onDone}
    >
      <div className="flex flex-col gap-4">
        <div className="flex">
          <PrimaryButton type="button" onClick={() => openSetup(null)}>
            Add a network
          </PrimaryButton>
        </div>

        {error !== null && (
          <p role="alert" className="text-[12px] text-[var(--danger)]">
            {error}
          </p>
        )}

        {networks.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            Nothing configured. A network is a server address and a nickname.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
            {networks.map((network) => (
              <li key={network.id} className="flex items-start justify-between gap-4 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                    {/* The same dot the sidebar row draws, off the same
                        colours, so one network does not look like two things. */}
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: connectionColor(network.status) }}
                    />
                    {network.name}
                    <span className="text-[11px] font-normal text-[var(--text-muted)]">
                      {connectionLabel(network.status)}
                    </span>
                  </h3>
                  <p className="font-mono text-[11px] text-[var(--text-muted)]">
                    {network.host}:{network.port} {network.tls ? "· TLS" : "· no TLS"}
                    {network.currentNick && ` · ${network.currentNick}`}
                  </p>
                  {network.status.state === "failed" && (
                    <p className="text-[11px] text-[var(--danger)]">
                      {network.status.detail.message}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {confirming === network.id ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Remove ${network.name}`}
                        onClick={() => void remove(network)}
                        className="h-8 rounded-[var(--radius-sm)] border border-[var(--danger)] px-3 text-[12px] text-[var(--danger)] hover:bg-[var(--surface-hover)]"
                      >
                        Remove
                      </button>
                      <SecondaryButton
                        label={`Keep ${network.name}`}
                        onClick={() => setConfirming(null)}
                      >
                        Keep
                      </SecondaryButton>
                    </>
                  ) : (
                    <>
                      <SecondaryButton
                        label={
                          network.status.state === "disconnected"
                            ? `Connect ${network.name}`
                            : `Disconnect ${network.name}`
                        }
                        onClick={() => void toggleConnection(network)}
                      >
                        {network.status.state === "disconnected" ? "Connect" : "Disconnect"}
                      </SecondaryButton>
                      <SecondaryButton
                        label={`Settings for ${network.name}`}
                        onClick={() => openSetup(network.id)}
                      >
                        Settings
                      </SecondaryButton>
                      <SecondaryButton
                        label={`Remove ${network.name}`}
                        onClick={() => setConfirming(network.id)}
                      >
                        Remove
                      </SecondaryButton>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsPage>
  );
}
