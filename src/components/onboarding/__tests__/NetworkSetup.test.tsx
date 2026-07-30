import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import type { NetworkConfig } from "@/types";
import { NetworkSetup } from "../NetworkSetup";

const listNetworkConfigs = vi.fn<() => Promise<NetworkConfig[]>>();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listNetworkConfigs: () => listNetworkConfigs(),
    saveNetwork: vi.fn(),
    connectNetwork: vi.fn(),
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

  it("closes on Escape", async () => {
    open("libera");
    const dialog = await screen.findByRole("dialog");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(useAppStore.getState().setup).toBeNull();
  });
});
