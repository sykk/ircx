import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import type { Channel, ConnectionStatus, Network, SaslStatus } from "@/types";
import { Connecting } from "../Connecting";

const onDone = vi.fn();
const onRetry = vi.fn();
const onBack = vi.fn();

/** What core writes when a server refuses a login. It is long on purpose — it
 * names the account and says where to fix it — which is what made repeating it
 * a problem rather than a redundancy nobody would notice. */
const REFUSED =
  "irc.libera.chat rejected the account sable — challenge proof invalid. " +
  "Check the account name and password in this network's settings.";

function mount(
  patch: Partial<Network> = {},
  { channels = [] as Channel[], error = null as string | null } = {},
) {
  seedStore(
    [makeNetwork("libera", { name: "Libera.Chat", host: "irc.libera.chat", ...patch })],
    channels,
  );
  render(
    <Connecting
      network="libera"
      error={error}
      onRetry={onRetry}
      onBack={onBack}
      onDone={onDone}
    />,
  );
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("Connecting", () => {
  it("names the server it is talking to", () => {
    mount({ status: { state: "connecting" } });
    expect(screen.getByText("irc.libera.chat:6697 · TLS")).toBeTruthy();
  });

  it.each<[ConnectionStatus, string]>([
    [{ state: "disconnected" }, "Not connected to irc.libera.chat:6697 yet"],
    [{ state: "connecting" }, "Connecting to irc.libera.chat:6697"],
    [{ state: "registering" }, "Registering with irc.libera.chat:6697"],
    [
      { state: "reconnecting", detail: { inSeconds: 12 } },
      "Connection lost. Trying irc.libera.chat:6697 again in 12s",
    ],
    [{ state: "failed", detail: { message: "" } }, "Could not connect to irc.libera.chat:6697"],
  ])("reports %o as the backend gave it", (status, line) => {
    mount({ status });
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("leaves onboarding as soon as the backend says connected", () => {
    mount({ status: { state: "connected" } });
    expect(onDone).toHaveBeenCalled();
  });

  it("stays put while the connection is still being made", () => {
    mount({ status: { state: "registering" } });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says nothing about authentication until the backend starts it", () => {
    mount({ status: { state: "registering" } });
    expect(screen.queryByText(/authenticat/i)).toBeNull();
  });

  it.each<[SaslStatus, string]>([
    [{ state: "inProgress" }, "Authenticating"],
    [{ state: "authenticated", detail: { account: "sable" } }, "Authenticated as sable"],
    [
      { state: "failed", detail: { message: "Invalid account credentials" } },
      "Authentication failed: Invalid account credentials",
    ],
  ])("reports SASL %o", (sasl, line) => {
    mount({ status: { state: "registering" }, sasl });
    expect(screen.getByText(line)).toBeTruthy();
  });

  it("names the channels once they are joined", () => {
    mount(
      { status: { state: "registering" } },
      {
        channels: [makeChannel("libera", "#linux"), makeChannel("libera", "#rust")],
      },
    );
    expect(screen.getByText("Joined #linux, #rust")).toBeTruthy();
  });

  it("counts the joins while some are outstanding", () => {
    mount(
      { status: { state: "registering" } },
      {
        channels: [
          makeChannel("libera", "#linux"),
          makeChannel("libera", "#rust", { joined: false }),
        ],
      },
    );
    expect(screen.getByText("Joined 1 of 2 channels")).toBeTruthy();
  });

  it("carries the failure message core wrote, not one of its own", () => {
    mount({
      status: { state: "failed", detail: { message: "irc.libera.chat refused the certificate" } },
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "irc.libera.chat refused the certificate",
    );
  });

  it("says the server was reached when it got as far as refusing a login", () => {
    mount({
      status: { state: "failed", detail: { message: REFUSED } },
      sasl: { state: "failed", detail: { message: REFUSED } },
    });
    expect(screen.getByText("Connected to irc.libera.chat:6697")).toBeTruthy();
    expect(screen.queryByText("Could not connect to irc.libera.chat:6697")).toBeNull();
  });

  it("states a refusal once, on the line that announces it", () => {
    mount({
      status: { state: "failed", detail: { message: REFUSED } },
      sasl: { state: "failed", detail: { message: REFUSED } },
    });
    expect(screen.getByText("Authentication failed")).toBeTruthy();
    expect(screen.getAllByText(REFUSED)).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(REFUSED);
  });

  it("keeps the reason on the step when the connection outlived the refusal", () => {
    mount({
      status: { state: "registering" },
      sasl: { state: "failed", detail: { message: "This server does not offer SASL" } },
    });
    expect(
      screen.getByText("Authentication failed: This server does not offer SASL"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a retry and a way back to the settings when it fails", () => {
    mount({ status: { state: "failed", detail: { message: "no route to host" } } });

    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalled();

    screen.getByRole("button", { name: "Edit settings" }).click();
    expect(onBack).toHaveBeenCalled();
  });

  it("shows a command that never reached the backend in place of a status", () => {
    mount({ status: { state: "disconnected" } }, { error: "ircx is not running" });
    expect(screen.getByRole("alert").textContent).toBe("ircx is not running");
  });

  it("lets the user get on with it while the connection is still in flight", () => {
    mount({ status: { state: "connecting" } });
    screen.getByRole("button", { name: "Continue without waiting" }).click();
    expect(onDone).toHaveBeenCalled();
  });
});
