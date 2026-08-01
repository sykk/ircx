import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import type { ConnectionStatus, InstalledPlugin } from "@/types";
import { StatusBar } from "../StatusBar";
import { makeNetwork, resetStore, seedStore } from "../fixtures";

function plugin(name: string, granted: boolean): InstalledPlugin {
  return {
    id: name.toLowerCase(),
    name,
    version: "1.0.0",
    description: `${name} does something`,
    commands: [],
    requests: { permissions: ["add-commands"], channels: [], hosts: [] },
    grants: { permissions: granted ? ["add-commands"] : [], channels: [], hosts: [] },
  };
}

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

  it("names the network that failed rather than half the reason why", () => {
    const bar = mount({ state: "failed", detail: { message: "certificate expired" } });
    expect(bar.textContent).toContain("irc.libera.chat:6697 failed");
    expect(bar.textContent).not.toContain("certificate expired");
  });

  it("gives up the reason when asked, the way the rest of the bar does", () => {
    mount({ state: "failed", detail: { message: "certificate expired" } });
    const summary = screen.getByLabelText("irc.libera.chat:6697 failed: certificate expired");

    fireEvent.focus(summary);
    expect(screen.getByRole("tooltip").textContent).toBe("certificate expired");

    fireEvent.blur(summary);
    expect(screen.queryByRole("tooltip")).toBeNull();
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

  /**
   * The indicator read `SASL` in every state, so the four cases below were all
   * the same word with a differently coloured dot. Each asserts the visible
   * text as well as the label it carries for a screen reader: the tooltip was
   * always right, and the tooltip is not what somebody glancing at the bar
   * reads.
   */
  describe("whether you are signed in", () => {
    it("says so, and as whom", () => {
      const bar = mount(
        { state: "connected" },
        { sasl: { state: "authenticated", detail: { account: "sable" } } },
      );
      expect(bar.textContent).toContain("signed in as sable");
      expect(screen.getByLabelText("Authenticated as sable")).toBeTruthy();
    });

    /** The case that started this: a mechanism the server never offered leaves
     * a connection that succeeded and an account that is not signed in. */
    it("says you are not, when it failed", () => {
      const bar = mount(
        { state: "connected" },
        {
          sasl: {
            state: "failed",
            detail: { message: "localhost does not accept SASL SCRAM-SHA-512" },
          },
        },
      );
      expect(bar.textContent).toContain("not signed in");
      expect(
        screen.getByLabelText(
          "SASL failed: localhost does not accept SASL SCRAM-SHA-512",
        ),
      ).toBeTruthy();
    });

    it("says it is still trying, while it is", () => {
      const bar = mount({ state: "connected" }, { sasl: { state: "inProgress" } });
      expect(bar.textContent).toContain("signing in");
      expect(screen.getByLabelText("Authenticating")).toBeTruthy();
    });

    /** Nothing failed and nothing is signed in. Reporting an absence the user
     * chose as a fault would make the bar cry wolf on every unauthenticated
     * network. */
    it("reports no account rather than a failure when none was configured", () => {
      const bar = mount({ state: "connected" });
      expect(bar.textContent).toContain("no account");
      expect(bar.textContent).not.toContain("not signed in");
      expect(screen.getByLabelText("SASL is not configured")).toBeTruthy();
    });

    /** The four states have to be four things a reader can tell apart. */
    it("says something different in each state", () => {
      const seen = new Set<string>();
      for (const sasl of [
        { state: "authenticated", detail: { account: "sable" } },
        { state: "failed", detail: { message: "bad password" } },
        { state: "inProgress" },
        { state: "notConfigured" },
      ] as const) {
        const bar = mount({ state: "connected" }, { sasl });
        seen.add(bar.textContent ?? "");
        cleanup();
      }
      expect(seen.size).toBe(4);
    });
  });

  describe("plugins", () => {
    it("says none are installed rather than nothing at all", () => {
      const bar = mount({ state: "connected" });
      expect(bar.textContent).toContain("Plugins 0");
      expect(screen.getByLabelText("Plugins 0: No plugins installed")).toBeTruthy();
    });

    it("counts and names the plugins that hold a permission", () => {
      useAppStore.setState({ plugins: [plugin("Greeter", true), plugin("Notes", true)] });
      const bar = mount({ state: "connected" });

      expect(bar.textContent).toContain("Plugins 2");
      expect(screen.getByLabelText("Plugins 2: Greeter 1.0.0, Notes 1.0.0")).toBeTruthy();
    });

    // Installed is not usable. A plugin nobody can invoke does nothing, and a
    // bare count of what is installed would say otherwise.
    it("separates the plugins that can be reached from the ones that cannot", () => {
      useAppStore.setState({ plugins: [plugin("Greeter", true), plugin("Notes", false)] });
      const bar = mount({ state: "connected" });

      expect(bar.textContent).toContain("Plugins 1 of 2");
      expect(
        screen.getByLabelText(
          "Plugins 1 of 2: Greeter 1.0.0, Notes 1.0.0 · Notes cannot be used until granted a command",
        ),
      ).toBeTruthy();
    });

    /** Holding a permission is not the same as being usable: slash commands are
     * the only extension point built, so a plugin without `add-commands` has
     * nothing anyone can type however much else it holds. */
    it("does not count a plugin that holds permissions but adds no command", () => {
      const hoarder = plugin("Hoarder", false);
      useAppStore.setState({
        plugins: [
          {
            ...hoarder,
            requests: { permissions: ["store-local-data"], channels: [], hosts: [] },
            grants: { permissions: ["store-local-data"], channels: [], hosts: [] },
          },
        ],
      });
      const bar = mount({ state: "connected" });

      expect(bar.textContent).toContain("Plugins 0 of 1");
    });

    it("says the library would not open rather than reporting none installed", () => {
      useAppStore.setState({
        plugins: [],
        pluginsUnavailable: "Your plugins folder could not be opened",
      });
      const bar = mount({ state: "connected" });

      expect(bar.textContent).toContain("Plugins —");
      expect(bar.textContent).not.toContain("Plugins 0");
      expect(
        screen.getByLabelText("Plugins unavailable: Your plugins folder could not be opened"),
      ).toBeTruthy();
    });

    it("reports plugins with no network configured, because they are not a connection", () => {
      useAppStore.setState({ plugins: [plugin("Greeter", true)] });
      render(<StatusBar />);

      expect(screen.getByText("No network")).toBeTruthy();
      expect(screen.getByText("Plugins 1")).toBeTruthy();
    });
  });
});
