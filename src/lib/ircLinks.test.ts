import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkConfig } from "@/types";
import { useAppStore } from "@/store";
import { makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { networkForIrcLink, openIrcLink, parseIrcLink } from "./ircLinks";

const calls = vi.hoisted(() => ({
  listNetworkConfigs: vi.fn(),
  connectNetwork: vi.fn(),
  joinChannel: vi.fn(),
  unminimize: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  insideTauri: () => false,
  ipc: {
    listNetworkConfigs: calls.listNetworkConfigs,
    connectNetwork: calls.connectNetwork,
    joinChannel: calls.joinChannel,
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: calls.unminimize,
    show: calls.show,
    setFocus: calls.setFocus,
  }),
}));

function network(patch: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    id: "libera",
    name: "Libera.Chat",
    host: "irc.libera.chat",
    port: 6697,
    tls: true,
    tlsVerify: true,
    socks5Proxy: null,
    clientCertificate: null,
    nick: "sable",
    altNicks: [],
    username: "sable",
    realname: "Sable",
    sasl: null,
    connectCommands: [],
    autojoin: [],
    autoConnect: true,
    ...patch,
  };
}

describe("IRC links", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    calls.connectNetwork.mockResolvedValue(undefined);
    calls.joinChannel.mockResolvedValue(undefined);
    calls.unminimize.mockResolvedValue(undefined);
    calls.show.mockResolvedValue(undefined);
    calls.setFocus.mockResolvedValue(undefined);
  });

  it("reads a secure channel link", () => {
    expect(parseIrcLink("ircs://irc.libera.chat/%23ircx")).toEqual({
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      target: "#ircx",
    });
  });

  it("accepts the channel without its prefix", () => {
    expect(parseIrcLink("irc://irc.example/rooms/help")).toEqual({
      host: "irc.example",
      port: 6667,
      tls: false,
      target: "#rooms/help",
    });
  });

  it("reads a fragment used as an unescaped channel", () => {
    expect(parseIrcLink("ircs://irc.example/#help")?.target).toBe("#help");
  });

  it("keeps an explicit port and channel prefix", () => {
    expect(parseIrcLink("ircs://irc.example:7000/%26staff")).toEqual({
      host: "irc.example",
      port: 7000,
      tls: true,
      target: "&staff",
    });
  });

  it.each([
    "https://irc.libera.chat/#ircx",
    "irc://user@irc.libera.chat/#ircx",
    "irc://irc.libera.chat/#bad,channel",
    "irc://irc.libera.chat/%zz",
    "irc://irc.libera.chat/?key=secret#one",
    "irc:///ircx",
  ])("refuses %s", (raw) => {
    expect(parseIrcLink(raw)).toBeNull();
  });

  it("matches host, transport, and port", () => {
    const link = parseIrcLink("ircs://IRC.LIBERA.CHAT/#ircx");
    expect(link).not.toBeNull();
    expect(networkForIrcLink(link!, [network()])?.id).toBe("libera");
    expect(networkForIrcLink(link!, [network({ tls: false })])).toBeNull();
    expect(networkForIrcLink(link!, [network({ port: 7000 })])).toBeNull();
  });

  it("does not match an unsaved config", () => {
    const link = parseIrcLink("ircs://irc.libera.chat");
    expect(networkForIrcLink(link!, [network({ id: null })])).toBeNull();
  });

  it("joins a channel on a configured network", async () => {
    seedStore([
      makeNetwork("libera", {
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        status: { state: "connected" },
      }),
    ]);
    calls.listNetworkConfigs.mockResolvedValue([network()]);

    await openIrcLink(parseIrcLink("ircs://irc.libera.chat/#ircx")!);

    expect(calls.connectNetwork).not.toHaveBeenCalled();
    expect(calls.joinChannel).toHaveBeenCalledWith("libera", "#ircx");
    expect(useAppStore.getState().views[useAppStore.getState().activeViewId!]?.target).toBe(
      "#ircx",
    );
    expect(calls.setFocus).toHaveBeenCalled();
  });

  it("starts a stopped configured network", async () => {
    seedStore([
      makeNetwork("libera", {
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        status: { state: "disconnected" },
      }),
    ]);
    calls.listNetworkConfigs.mockResolvedValue([network()]);

    await openIrcLink(parseIrcLink("ircs://irc.libera.chat")!);

    expect(calls.connectNetwork).toHaveBeenCalledWith("libera");
    expect(useAppStore.getState().views[useAppStore.getState().activeViewId!]?.target).toBe("*");
  });

  it("opens setup for a server that is not configured", async () => {
    calls.listNetworkConfigs.mockResolvedValue([]);
    const link = parseIrcLink("irc://irc.example:7000/#help")!;

    await openIrcLink(link);

    expect(useAppStore.getState().setup).toEqual({ network: null, link });
    expect(useAppStore.getState().settings).toBe("networks");
  });
});
