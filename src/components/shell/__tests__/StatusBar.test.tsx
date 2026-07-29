import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "@/types";
import { StatusBar } from "../StatusBar";
import { makeNetwork, resetStore, seedStore } from "../fixtures";

function mount(status: ConnectionStatus, patch: Parameters<typeof makeNetwork>[1] = {}) {
  seedStore([makeNetwork("libera", { host: "irc.libera.chat", status, ...patch })]);
  render(<StatusBar />);
  return screen.getByRole("contentinfo");
}

beforeEach(resetStore);

describe("StatusBar", () => {
  it("says nothing about a connection when no network is configured", () => {
    render(<StatusBar />);
    expect(screen.getByText("No network")).toBeTruthy();
  });

  it("reports the server and TLS state when connected", () => {
    const bar = mount({ state: "connected" });
    expect(bar.textContent).toContain("Connected to irc.libera.chat:6697");
    expect(bar.textContent).toContain("(TLS)");
  });

  it("does not claim TLS on a plaintext connection", () => {
    const bar = mount({ state: "connected" }, { tls: false, port: 6667 });
    expect(bar.textContent).toContain("Connected to irc.libera.chat:6667");
    expect(bar.textContent).toContain("(no TLS)");
  });

  it("distinguishes connecting from registering", () => {
    const bar = mount({ state: "connecting" });
    expect(bar.textContent).toContain("Connecting to irc.libera.chat:6697");
  });

  it("reports registration separately from a completed connection", () => {
    const bar = mount({ state: "registering" });
    expect(bar.textContent).toContain("Registering with irc.libera.chat:6697");
  });

  it("reports a disconnected network without dressing it up", () => {
    const bar = mount({ state: "disconnected" });
    expect(bar.textContent).toContain("Not connected to irc.libera.chat:6697");
  });

  it("carries the failure reason the backend gave", () => {
    const bar = mount({ state: "failed", detail: { message: "certificate expired" } });
    expect(bar.textContent).toContain("certificate expired");
  });

  describe("reconnecting", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("counts the retry down to zero and stops there", () => {
      const bar = mount({ state: "reconnecting", detail: { inSeconds: 3 } });
      expect(bar.textContent).toContain("Reconnecting to irc.libera.chat:6697 in 3s");

      act(() => void vi.advanceTimersByTime(2000));
      expect(bar.textContent).toContain("in 1s");

      act(() => void vi.advanceTimersByTime(5000));
      expect(bar.textContent).toContain("in 0s");
    });
  });

  it("shows lag only once the backend has measured it", () => {
    const bar = mount({ state: "connected" });
    expect(bar.textContent).toContain("Lag —");
  });

  it("shows the measured lag in milliseconds", () => {
    const bar = mount({ state: "connected" }, { lagMs: 42 });
    expect(bar.textContent).toContain("Lag 42ms");
  });

  it("counts the negotiated capabilities and names them", () => {
    mount({ state: "connected" }, { capsEnabled: ["server-time", "sasl"] });
    expect(
      screen.getByLabelText("Capabilities: sasl, server-time").textContent,
    ).toContain("Caps 2");
  });

  it("reports no capabilities rather than an empty list", () => {
    mount({ state: "connected" });
    expect(screen.getByLabelText("Capabilities: No capabilities negotiated")).toBeTruthy();
  });

  it("names the SASL account when authentication succeeded", () => {
    mount({ state: "connected" }, { sasl: { state: "authenticated", detail: { account: "sable" } } });
    expect(screen.getByLabelText("Authenticated as sable")).toBeTruthy();
  });

  it("reports SASL as unconfigured rather than implying it is off by choice of the server", () => {
    mount({ state: "connected" });
    expect(screen.getByLabelText("SASL is not configured")).toBeTruthy();
  });

  it("carries the SASL failure reason", () => {
    mount({ state: "connected" }, { sasl: { state: "failed", detail: { message: "bad password" } } });
    expect(screen.getByLabelText("SASL failed: bad password")).toBeTruthy();
  });
});
