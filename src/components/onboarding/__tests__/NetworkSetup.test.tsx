import { act, fireEvent, render, screen } from "@testing-library/react";
import { needsPassword } from "../config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import type { NetworkConfig } from "@/types";
import { NetworkSetup } from "../NetworkSetup";

const listNetworkConfigs = vi.fn<() => Promise<NetworkConfig[]>>();
const removeNetwork = vi.fn<(id: string) => Promise<void>>();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listNetworkConfigs: () => listNetworkConfigs(),
    saveNetwork: vi.fn(),
    connectNetwork: vi.fn(),
    removeNetwork: (id: string) => removeNetwork(id),
  },
  onIrcxEvent: vi.fn(),
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

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  listNetworkConfigs.mockResolvedValue([LIBERA]);
});

function open(network: string | null) {
  useAppStore.getState().openSetup(network);
  render(<NetworkSetup />);
}

describe("NetworkSetup", () => {
  it("stays out of the way until something opens it", () => {
    const { container } = render(<NetworkSetup />);
    expect(container.firstChild).toBeNull();
    expect(listNetworkConfigs).not.toHaveBeenCalled();
  });

  it("opens the server form for a network that does not exist yet", () => {
    open(null);
    expect(screen.getByRole("heading", { name: "Connect to an IRC server" })).toBeTruthy();
    expect(listNetworkConfigs).not.toHaveBeenCalled();
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

  /**
   * #130: `ipc.removeNetwork` was called from nowhere, so a network pointed at a
   * host that did not exist was permanent — and it kept retrying.
   */
  describe("removing a network", () => {
    beforeEach(() => removeNetwork.mockResolvedValue(undefined));

    it("asks before removing, because it disconnects and forgets the settings", async () => {
      listNetworkConfigs.mockResolvedValue([LIBERA]);
      open("libera");
      await screen.findByDisplayValue("irc.libera.chat");

      fireEvent.click(screen.getByRole("button", { name: "Remove this network" }));

      expect(screen.getByRole("button", { name: "Remove Libera.Chat" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
    });

    it("puts the sheet away once the network is gone", async () => {
      listNetworkConfigs.mockResolvedValue([LIBERA]);
      open("libera");
      await screen.findByDisplayValue("irc.libera.chat");
      fireEvent.click(screen.getByRole("button", { name: "Remove this network" }));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Remove Libera.Chat" }));
      });

      expect(useAppStore.getState().setup).toBeNull();
    });

    it("offers nothing to remove while a network is being added", () => {
      open(null);
      expect(screen.queryByRole("button", { name: "Remove this network" })).toBeNull();
    });
  });

  it("closes on Escape", async () => {
    open("libera");
    const dialog = await screen.findByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(useAppStore.getState().setup).toBeNull();
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
