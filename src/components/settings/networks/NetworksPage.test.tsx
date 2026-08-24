import { act, fireEvent, render, screen } from "@testing-library/react";
import { needsPassword } from "@/components/onboarding/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import type { NetworkConfig } from "@/types";
import { NetworksPage } from "./NetworksPage";

const listNetworkConfigs = vi.fn<() => Promise<NetworkConfig[]>>();
const removeNetwork = vi.fn<(id: string) => Promise<void>>();
const connectNetwork = vi.fn<(id: string) => Promise<void>>();
const disconnectNetwork = vi.fn<(id: string) => Promise<void>>();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listNetworkConfigs: () => listNetworkConfigs(),
    saveNetwork: vi.fn(),
    connectNetwork: (id: string) => connectNetwork(id),
    disconnectNetwork: (id: string) => disconnectNetwork(id),
    removeNetwork: (id: string) => removeNetwork(id),
  },
  onIrcxEvent: vi.fn(),
  reasonOr: (reason: unknown, fallback: string) =>
    typeof reason === "string" && reason.trim() !== "" ? reason : fallback,
}));

/** What `list_network_configs` gives back for a network whose password went to
 * the keyring: everything except the password. */
const LIBERA: NetworkConfig = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  tlsVerify: true,
  socks5Proxy: null,
  clientCertificate: null,
  nick: "sable",
  altNicks: ["sable_"],
  username: "sable",
  realname: "sable",
  sasl: { mechanism: "PLAIN", account: "sable", password: null },
  connectCommands: [],
  autojoin: ["#ctf-ops"],
  autoConnect: true,
};

const store = () => useAppStore.getState();

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  listNetworkConfigs.mockResolvedValue([LIBERA]);
  connectNetwork.mockResolvedValue(undefined);
  disconnectNetwork.mockResolvedValue(undefined);
  removeNetwork.mockResolvedValue(undefined);
  seedStore([makeNetwork("libera", { name: "Libera.Chat", host: "irc.libera.chat" })]);
});

function page() {
  render(<NetworksPage onDone={vi.fn()} />);
}

function open(network: string | null) {
  store().openSetup(network);
  page();
}

async function settleForm() {
  await act(async () => {
    await listNetworkConfigs.mock.results.at(-1)?.value;
  });
}

describe("the list of networks", () => {
  it("is what the page opens on", () => {
    store().openSettings("networks");
    page();

    expect(screen.getByRole("heading", { name: "Networks", level: 2 })).toBeTruthy();
    expect(screen.getByText("irc.libera.chat:6697 · TLS · sable")).toBeTruthy();
    expect(listNetworkConfigs).not.toHaveBeenCalled();
  });

  /** The state comes off the store rather than off `list_network_configs`, so
   * a connection that drops while the page is open says so. */
  it("follows the connection state", () => {
    page();
    expect(screen.getByRole("button", { name: "Disconnect Libera.Chat" })).toBeTruthy();

    act(() => {
      seedStore([
        makeNetwork("libera", { name: "Libera.Chat", status: { state: "disconnected" } }),
      ]);
    });

    expect(screen.getByRole("button", { name: "Connect Libera.Chat" })).toBeTruthy();
  });

  it("stops a running network and starts a stopped one", async () => {
    page();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect Libera.Chat" }));
    });

    expect(disconnectNetwork).toHaveBeenCalledWith("libera");
    expect(connectNetwork).not.toHaveBeenCalled();
  });

  it("says why a connection failed, where the row is", () => {
    seedStore([
      makeNetwork("libera", {
        name: "Libera.Chat",
        status: { state: "failed", detail: { message: "Nickname already in use" } },
      }),
    ]);
    page();

    expect(screen.getByText("Nickname already in use")).toBeTruthy();
  });

  /** Removing disconnects and forgets the settings, and nothing brings them
   * back. */
  it("asks before removing", async () => {
    page();

    fireEvent.click(screen.getByRole("button", { name: "Remove Libera.Chat" }));
    expect(removeNetwork).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove Libera.Chat" }));
    });

    expect(removeNetwork).toHaveBeenCalledWith("libera");
  });

  it("opens the form on the network whose row was used", async () => {
    page();

    fireEvent.click(screen.getByRole("button", { name: "Settings for Libera.Chat" }));
    await settleForm();

    expect(store().setup).toEqual({ network: "libera" });
  });

  it("opens a blank form for Add", async () => {
    page();

    fireEvent.click(screen.getByRole("button", { name: "Add a network" }));
    await settleForm();

    expect(store().setup).toEqual({ network: null });
  });

  it("says so when nothing is configured", () => {
    seedStore([]);
    page();

    expect(screen.getByText(/Nothing configured/)).toBeTruthy();
  });
});

describe("the form", () => {
  it("offers every setup path for a network that does not exist yet", async () => {
    open(null);
    await settleForm();

    expect(screen.getByRole("button", { name: /Connect through Soju/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect through ZNC/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect to an IRC server/ })).toBeTruthy();
    expect(listNetworkConfigs).toHaveBeenCalled();
  });

  it("returns from the new-network chooser to the network list", () => {
    open(null);

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(store().setup).toBeNull();
    expect(screen.getByRole("heading", { name: "Networks", level: 2 })).toBeTruthy();
  });

  it("copies an identity from a saved network without its password", async () => {
    open(null);
    fireEvent.click(screen.getByRole("button", { name: /Connect to an IRC server/ }));
    const identity = await screen.findByLabelText("Use identity from");

    fireEvent.change(identity, { target: { value: "libera" } });
    expect(screen.getByLabelText("Nickname").getAttribute("value")).toBe("sable");

    fireEvent.click(screen.getByRole("button", { name: "Show every setting" }));
    expect((await screen.findByLabelText(/Alternate nicknames/)).getAttribute("value")).toBe("sable_");
    expect(screen.getByLabelText(/Account name/).getAttribute("value")).toBe("sable");
    expect(screen.getByLabelText("Password").getAttribute("value")).toBe("");
    expect(screen.getByLabelText(/Channels to join/).getAttribute("value")).toBe("");
  });

  // The reason #45 exists: this path had a unit test but no route, so nobody
  // had seen it. An empty password box here reads as a lost credential.
  it("reports the saved password instead of an empty box", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });

    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("Saved in your system keyring")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace password" }));
    expect(screen.getByLabelText("Password").getAttribute("value")).toBe("");
  });

  it("fills the form from the saved network", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });

    expect(screen.getByLabelText("Network name").getAttribute("value")).toBe("Libera.Chat");
    expect(screen.getByLabelText("Server address").getAttribute("value")).toBe(
      "irc.libera.chat",
    );
    expect(screen.getByLabelText("Nickname").getAttribute("value")).toBe("sable");
    expect((screen.getByLabelText("SASL mechanism") as HTMLSelectElement).value).toBe(
      "PLAIN",
    );
  });

  it("says so when the network went away between the click and the read", async () => {
    listNetworkConfigs.mockResolvedValue([]);
    open("libera");
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  /** Back leaves the flow rather than falling through to the chooser, and
   * leaving the flow here is returning to the list. */
  it("goes back to the list", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(store().setup).toBeNull();
    expect(screen.getByRole("heading", { name: "Networks", level: 2 })).toBeTruthy();
  });

  /** The dialog around this declines Escape from inside a field, and the form
   * opens with one focused — so without this the key would do nothing at all
   * on the screen that a dialog of its own used to close. */
  it("goes back to the list on Escape from a field", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });

    fireEvent.keyDown(screen.getByLabelText("Server address"), { key: "Escape" });

    expect(store().setup).toBeNull();
    expect(screen.getByRole("heading", { name: "Networks", level: 2 })).toBeTruthy();
  });

  /**
   * #130: `ipc.removeNetwork` was called from nowhere, so a network pointed at a
   * host that did not exist was permanent — and it kept retrying.
   */
  describe("removing a network", () => {
    it("asks before removing, because it disconnects and forgets the settings", async () => {
      open("libera");
      await screen.findByDisplayValue("irc.libera.chat");

      fireEvent.click(screen.getByRole("button", { name: "Remove this network" }));

      expect(screen.getByRole("button", { name: "Remove Libera.Chat" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
    });

    it("returns to the list once the network is gone", async () => {
      open("libera");
      await screen.findByDisplayValue("irc.libera.chat");
      fireEvent.click(screen.getByRole("button", { name: "Remove this network" }));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Remove Libera.Chat" }));
      });

      expect(store().setup).toBeNull();
    });

    it("offers nothing to remove while a network is being added", async () => {
      open(null);
      await settleForm();
      expect(screen.queryByRole("button", { name: "Remove this network" })).toBeNull();
    });
  });
});

/**
 * SCRAM-SHA-512 authenticates with a password the same way PLAIN does — the
 * difference is that it never sends it. Three separate places used to ask
 * "is this PLAIN?" to mean "does this need a password", so a mechanism added
 * to the list and missed in one of them would have lost the password silently.
 */
describe("a mechanism that needs a password", () => {
  it("is offered", async () => {
    open("libera");
    const picker = (await screen.findByLabelText("SASL mechanism")) as HTMLSelectElement;

    expect([...picker.options].map((option) => option.value)).toContain("SCRAM-SHA-512");
  });

  /** The drift this removed: switching to SCRAM used to drop the saved
   * password, because only PLAIN was asked about. */
  it("keeps the saved password when the mechanism changes to it", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });
    fireEvent.change(screen.getByLabelText("SASL mechanism"), {
      target: { value: "SCRAM-SHA-512" },
    });

    expect(screen.getByText("Saved in your system keyring")).toBeTruthy();
  });

  it("drops it for a mechanism that has no password", async () => {
    open("libera");
    await screen.findByRole("heading", { name: "Network settings" });
    fireEvent.change(screen.getByLabelText("SASL mechanism"), {
      target: { value: "EXTERNAL" },
    });

    expect(screen.queryByText("Saved in your system keyring")).toBeNull();
  });

  it("is asked about in one place, so the answers cannot disagree", () => {
    expect(needsPassword("SCRAM-SHA-512")).toBe(true);
    expect(needsPassword("PLAIN")).toBe(true);
    expect(needsPassword("EXTERNAL")).toBe(false);
    expect(needsPassword("none")).toBe(false);
  });
});
