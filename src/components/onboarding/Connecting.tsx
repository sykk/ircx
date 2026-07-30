import { useEffect } from "react";
import { connectionColor } from "@/components/shell/connection";
import { useChannelsFor, useNetwork } from "@/store/selectors";
import type { Channel, ConnectionStatus, Network, SaslStatus } from "@/types";
import { LinkButton, PrimaryButton, SecondaryButton } from "./fields";

interface Props {
  network: string;
  /** A save that succeeded but a connect that never started leaves no status to
   * report, so the caller's error is rendered in place of one. */
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  onDone: () => void;
}

/**
 * Every line here comes from an event the backend published. There is no
 * scripted sequence: a step appears when the backend says it happened.
 */
export function Connecting({ network, error, onRetry, onBack, onDone }: Props) {
  const net = useNetwork(network);
  const channels = useChannelsFor(network);
  const connected = net?.status.state === "connected";

  useEffect(() => {
    if (connected) onDone();
  }, [connected, onDone]);

  const failure = net?.status.state === "failed" ? net.status.detail.message : error;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-[17px] font-medium text-[var(--text-primary)]">
          {net ? net.name : "Setting up the network"}
        </h1>
        {net && (
          <p className="font-mono text-[12px] text-[var(--text-muted)]">
            {net.host}:{net.port} {net.tls ? "· TLS" : "· no TLS"}
          </p>
        )}
      </header>

      <ul className="flex flex-col gap-2">
        {net ? (
          <Line color={connectionColor(net.status)}>{connectionLine(net)}</Line>
        ) : (
          <Line color="var(--state-connecting)">Saving the network</Line>
        )}
        {net && net.sasl.state !== "notConfigured" && (
          <Line color={saslColor(net.sasl)}>{saslLine(net.sasl)}</Line>
        )}
        {channels.length > 0 && (
          <Line color={channels.every((c) => c.joined) ? "var(--state-connected)" : "var(--state-connecting)"}>
            {channelLine(channels)}
          </Line>
        )}
      </ul>

      {failure ? (
        <>
          <p role="alert" className="text-[12px] text-[var(--danger)]">
            {failure}
          </p>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={onBack}>Edit settings</SecondaryButton>
            <PrimaryButton type="button" onClick={onRetry}>
              Try again
            </PrimaryButton>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={onBack}>Edit settings</SecondaryButton>
          <span className="flex-1" />
          <LinkButton onClick={onDone}>Continue without waiting</LinkButton>
        </div>
      )}
    </div>
  );
}

function Line({ color, children }: { color: string; children: string }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      {children}
    </li>
  );
}

function connectionLine(net: Network): string {
  const where = `${net.host}:${net.port}`;
  const status: ConnectionStatus = net.status;

  switch (status.state) {
    case "disconnected":
      return `Not connected to ${where} yet`;
    case "connecting":
      return `Connecting to ${where}`;
    case "registering":
      return `Registering with ${where}`;
    case "connected":
      return `Connected to ${where}`;
    case "reconnecting":
      return `Connection lost. Trying ${where} again in ${status.detail.inSeconds}s`;
    case "failed":
      return `Could not connect to ${where}`;
  }
}

function saslLine(status: SaslStatus): string {
  switch (status.state) {
    case "inProgress":
      return "Authenticating";
    case "authenticated":
      return `Authenticated as ${status.detail.account}`;
    case "failed":
      return `Authentication failed: ${status.detail.message}`;
    case "notConfigured":
      return "Not authenticating";
  }
}

function saslColor(status: SaslStatus): string {
  switch (status.state) {
    case "authenticated":
      return "var(--state-connected)";
    case "inProgress":
      return "var(--state-connecting)";
    case "failed":
      return "var(--state-error)";
    case "notConfigured":
      return "var(--state-disconnected)";
  }
}

function channelLine(channels: Channel[]): string {
  const joined = channels.filter((c) => c.joined);
  if (joined.length === channels.length) {
    return `Joined ${joined.map((c) => c.name).join(", ")}`;
  }
  return `Joined ${joined.length} of ${channels.length} channels`;
}
