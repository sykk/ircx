import { useState } from "react";
import { SecondaryButton } from "@/components/onboarding/fields";
import { connectionDetail, connectionLabel } from "@/components/shell/connection";
import { useAppStore } from "@/store";
import type { Network, SaslStatus } from "@/types";
import { SettingsPage } from "../SettingsPage";

function saslLabel(status: SaslStatus): string {
  switch (status.state) {
    case "authenticated":
      return status.detail.refused === null
        ? `Authenticated as ${status.detail.account}`
        : `Authenticated as ${status.detail.account}; ${status.detail.refused}`;
    case "inProgress":
      return "Authenticating";
    case "failed":
      return `Failed: ${status.detail.message}`;
    case "notConfigured":
      return "Not configured";
  }
}

function reportFor(network: Network): string {
  const detail = connectionDetail(network.status);
  return [
    network.name,
    `  Endpoint: ${network.host}:${network.port}`,
    `  TLS: ${network.tls ? "yes" : "no"}`,
    `  Status: ${connectionLabel(network.status)}${detail === null ? "" : ` (${detail})`}`,
    `  Nick: ${network.currentNick ?? "not registered"}`,
    `  SASL: ${saslLabel(network.sasl)}`,
    `  Lag: ${network.lagMs === null ? "unavailable" : `${network.lagMs} ms`}`,
    `  Capabilities: ${network.capsEnabled.length === 0 ? "none" : [...network.capsEnabled].sort().join(", ")}`,
  ].join("\n");
}

export function DiagnosticsPage({ onDone }: { onDone: () => void }) {
  const networkOrder = useAppStore((state) => state.networkOrder);
  const networksById = useAppStore((state) => state.networks);
  const networks = networkOrder.flatMap((id) => networksById[id] ?? []);
  const report = networks.map(reportFor).join("\n\n");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <SettingsPage
      title="Diagnostics"
      blurb="Live connection details for troubleshooting. Passwords and protocol logs are not included."
      onDone={onDone}
    >
      {networks.length === 0 ? (
        <p className="text-[13px] text-[var(--text-muted)]">No networks are configured.</p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {networks.map((network) => {
              const detail = connectionDetail(network.status);
              return (
                <section
                  key={network.id}
                  aria-labelledby={`diagnostics-${network.id}`}
                  className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <h3
                      id={`diagnostics-${network.id}`}
                      className="text-[14px] font-medium text-[var(--text-primary)]"
                    >
                      {network.name}
                    </h3>
                    <span className="text-[12px] text-[var(--text-secondary)]">
                      {connectionLabel(network.status)}
                    </span>
                  </div>
                  {detail !== null && (
                    <p className="mt-1 text-[12px] text-[var(--warning)]">{detail}</p>
                  )}
                  <dl className="mt-4 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
                    <dt className="text-[var(--text-muted)]">Endpoint</dt>
                    <dd className="font-mono text-[var(--text-secondary)]">
                      {network.host}:{network.port}
                    </dd>
                    <dt className="text-[var(--text-muted)]">Transport</dt>
                    <dd className="text-[var(--text-secondary)]">
                      {network.tls ? "TLS" : "Plaintext"}
                    </dd>
                    <dt className="text-[var(--text-muted)]">Nickname</dt>
                    <dd className="font-mono text-[var(--text-secondary)]">
                      {network.currentNick ?? "Not registered"}
                    </dd>
                    <dt className="text-[var(--text-muted)]">SASL</dt>
                    <dd className="text-[var(--text-secondary)]">{saslLabel(network.sasl)}</dd>
                    <dt className="text-[var(--text-muted)]">Lag</dt>
                    <dd className="tabular-nums text-[var(--text-secondary)]">
                      {network.lagMs === null ? "Unavailable" : `${network.lagMs} ms`}
                    </dd>
                    <dt className="text-[var(--text-muted)]">Capabilities</dt>
                    <dd className="break-words font-mono text-[var(--text-secondary)]">
                      {network.capsEnabled.length === 0
                        ? "None negotiated"
                        : [...network.capsEnabled].sort().join(", ")}
                    </dd>
                  </dl>
                </section>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <SecondaryButton onClick={() => void copyReport()}>Copy report</SecondaryButton>
            <span
              role={copyState === "failed" ? "alert" : "status"}
              className={
                copyState === "failed"
                  ? "text-[12px] text-[var(--danger)]"
                  : "text-[12px] text-[var(--text-muted)]"
              }
            >
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Could not copy the report. Select the details above and copy them manually."
                  : ""}
            </span>
          </div>
        </>
      )}
    </SettingsPage>
  );
}
