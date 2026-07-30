import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import type { NetworkConfig } from "@/types";
import { Onboarding } from "../Onboarding";

const saveNetwork = vi.fn<(config: NetworkConfig) => Promise<string>>();
const connectNetwork = vi.fn<(network: string) => Promise<void>>();

vi.mock("@/lib/ipc", () => ({
  ipc: {
    saveNetwork: (config: NetworkConfig) => saveNetwork(config),
    connectNetwork: (network: string) => connectNetwork(network),
  },
  onIrcxEvent: vi.fn(),
}));

const onDone = vi.fn();

function mount() {
  render(<Onboarding onDone={onDone} />);
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Presses Connect and lets the save and connect promises settle. */
async function connect() {
  click("Connect");
  await screen.findByRole("heading", { name: /Libera\.Chat|Setting up the network|Example/ });
}

function savedConfig(): NetworkConfig {
  expect(saveNetwork).toHaveBeenCalledTimes(1);
  return saveNetwork.mock.calls[0]?.[0] as NetworkConfig;
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  saveNetwork.mockResolvedValue("net-1");
  connectNetwork.mockResolvedValue();
});

describe("the first screen", () => {
  it("offers the three ways in", () => {
    mount();
    expect(screen.getByRole("button", { name: /Join a public network/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Connect to an IRC server/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Advanced setup/ })).toBeTruthy();
  });

  it("lets the user leave without configuring anything", () => {
    mount();
    click("Skip for now");
    expect(onDone).toHaveBeenCalled();
  });
});

describe("the public network path", () => {
  beforeEach(() => {
    mount();
    click(/Join a public network/);
  });

  it("asks for a nickname and offers Libera.Chat first", () => {
    expect(screen.getByRole("radio", { checked: true }).closest("label")?.textContent).toContain(
      "Libera.Chat",
    );
    expect(screen.getByLabelText("Nickname")).toBeTruthy();
  });

  it("refuses to connect without a nickname, and says so in words", () => {
    click("Connect");
    expect(screen.getByRole("alert").textContent).toContain("Choose a nickname");
    expect(saveNetwork).not.toHaveBeenCalled();
  });

  it("explains a nickname the server would reject before trying it", () => {
    type("Nickname", "9lives");
    expect(screen.getByRole("alert").textContent).toContain("cannot start with a digit");

    click("Connect");
    expect(saveNetwork).not.toHaveBeenCalled();
  });

  it("holds the nickname to Libera's sixteen characters", () => {
    type("Nickname", "a".repeat(17));
    expect(screen.getByRole("alert").textContent).toContain("16 characters");
  });

  it("connects over TLS on 6697 with nothing else asked for", async () => {
    type("Nickname", "sable");
    await connect();

    expect(savedConfig()).toMatchObject({
      name: "Libera.Chat",
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      tlsVerify: true,
      nick: "sable",
      sasl: null,
      autojoin: [],
    });
    expect(connectNetwork).toHaveBeenCalledWith("net-1");
  });

  it("authenticates with SASL when the user has an account", async () => {
    type("Nickname", "sable");
    fireEvent.click(screen.getByLabelText(/I have an account/));
    type("Password", "hunter2");
    await connect();

    expect(savedConfig().sasl).toEqual({
      mechanism: "PLAIN",
      account: "sable",
      password: "hunter2",
    });
  });

  it("joins the channels the user listed", async () => {
    type("Nickname", "sable");
    type(/Channels to join/, "linux, #rust");
    await connect();

    expect(savedConfig().autojoin).toEqual(["#linux", "#rust"]);
  });

  it("follows the network the user picked instead", async () => {
    fireEvent.click(screen.getByRole("radio", { name: /OFTC/ }));
    type("Nickname", "sable");
    await connect();

    expect(savedConfig()).toMatchObject({ name: "OFTC", host: "irc.oftc.net" });
  });

  it("keeps what has been typed when the user opens the advanced form", () => {
    type("Nickname", "sable");
    click("Advanced setup");

    expect(screen.getByLabelText("Nickname").getAttribute("value")).toBe("sable");
    expect(screen.getByLabelText("Server address").getAttribute("value")).toBe(
      "irc.libera.chat",
    );
  });

  it("stays on the form with the backend's reason when the save fails", async () => {
    saveNetwork.mockRejectedValue("The keyring is locked");
    type("Nickname", "sable");
    click("Connect");

    expect((await screen.findAllByRole("alert")).at(-1)?.textContent).toBe(
      "The keyring is locked",
    );
    expect(screen.getByLabelText("Nickname")).toBeTruthy();
  });
});

describe("the advanced path", () => {
  beforeEach(() => {
    mount();
    click(/Advanced setup/);
  });

  it("starts with an empty address rather than a network the user did not pick", () => {
    expect(screen.getByLabelText("Server address").getAttribute("value")).toBe("");
  });

  it("exposes every field of a NetworkConfig", async () => {
    type("Network name", "Example");
    type("Server address", "irc.example.org");
    type("Port", "6667");
    fireEvent.click(screen.getByLabelText("Connect over TLS"));
    fireEvent.click(screen.getByLabelText(/Verify the server's certificate/));
    type("Nickname", "sable");
    type(/Alternate nicknames/, "sable_ sable__");
    type(/Username/, "sbl");
    type(/Real name/, "Sable the cat");
    fireEvent.change(screen.getByLabelText("SASL mechanism"), {
      target: { value: "PLAIN" },
    });
    type(/Account name/, "sable-alt");
    type("Password", "hunter2");
    type(/Channels to join/, "#linux");
    type("Connect commands", "/mode sable +i");
    fireEvent.click(screen.getByLabelText(/Connect to this network when ircx starts/));

    click("Connect");
    await screen.findByRole("heading", { name: "Setting up the network" });

    expect(savedConfig()).toEqual<NetworkConfig>({
      id: null,
      name: "Example",
      host: "irc.example.org",
      port: 6667,
      tls: false,
      tlsVerify: false,
      nick: "sable",
      altNicks: ["sable_", "sable__"],
      username: "sbl",
      realname: "Sable the cat",
      sasl: { mechanism: "PLAIN", account: "sable-alt", password: "hunter2" },
      connectCommands: ["mode sable +i"],
      autojoin: ["#linux"],
      autoConnect: false,
    });
  });

  it("moves the port with the TLS switch", () => {
    fireEvent.click(screen.getByLabelText("Connect over TLS"));
    expect(screen.getByLabelText("Port").getAttribute("value")).toBe("6667");
  });

  it("asks for an address before it will connect", () => {
    type("Nickname", "sable");
    click("Connect");
    expect(screen.getByRole("alert").textContent).toContain("irc.example.org");
    expect(saveNetwork).not.toHaveBeenCalled();
  });

  it("reports the saved password rather than showing an empty box", async () => {
    type("Server address", "irc.example.org");
    type("Nickname", "sable");
    fireEvent.change(screen.getByLabelText("SASL mechanism"), {
      target: { value: "PLAIN" },
    });
    type("Password", "hunter2");

    click("Connect");
    await screen.findByRole("heading", { name: "Setting up the network" });
    click("Edit settings");

    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("Saved in your system keyring")).toBeTruthy();

    click("Replace password");
    expect(screen.getByLabelText("Password").getAttribute("value")).toBe("");
  });

  it("updates the saved network instead of adding a second one", async () => {
    type("Server address", "irc.example.org");
    type("Nickname", "sable");

    click("Connect");
    await screen.findByRole("heading", { name: "Setting up the network" });
    click("Edit settings");
    click("Connect");
    await screen.findByRole("heading", { name: "Setting up the network" });

    expect(saveNetwork.mock.calls[1]?.[0]?.id).toBe("net-1");
  });
});
