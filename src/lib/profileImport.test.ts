import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, NetworkConfig, ThemeSource } from "@/types";
import type * as Ipc from "@/lib/ipc";
import { resetStore } from "@/components/shell/fixtures";
import { parsePortableProfile, prepareProfileImport } from "./profileImport";

const listNetworkConfigs = vi.fn<() => Promise<NetworkConfig[]>>();
const listThemes = vi.fn<() => Promise<ThemeSource[]>>();
const listPlugins = vi.fn<() => Promise<InstalledPlugin[]>>();

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: {
    listNetworkConfigs: () => listNetworkConfigs(),
    listThemes: () => listThemes(),
    listPlugins: () => listPlugins(),
  },
}));

const PROFILE = {
  format: "ircx-profile",
  version: 1,
  networks: [
    {
      name: "Libera.Chat",
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      tlsVerify: true,
      socks5Proxy: null,
      nick: "sable",
      altNicks: ["sable_"],
      username: "sable",
      realname: "Sable",
      sasl: { mechanism: "PLAIN", account: "sable" },
      autojoin: ["#ircx"],
      autoConnect: true,
      quitMessage: null,
      partMessage: null,
      awayMessage: "Away",
    },
  ],
  appearance: {
    theme: "ircx-dark",
    installedThemes: ["paper"],
    density: "compact",
    presentation: {},
    typography: {},
    sidebarCompact: true,
    themeOverrides: {},
  },
  notifications: {
    desktop: { highlights: true, directMessages: false },
    highlightWords: ["deploy"],
    mutedConversations: [
      { network: "source-id", networkName: "Libera.Chat", target: "#noise" },
    ],
  },
  uploadProvider: null,
  plugins: [],
  omissions: [],
};

beforeEach(() => {
  resetStore();
  listNetworkConfigs.mockReset().mockResolvedValue([]);
  listThemes.mockReset().mockResolvedValue([]);
  listPlugins.mockReset().mockResolvedValue([]);
});

describe("portable profile parsing", () => {
  it("reads the current format", () => {
    const profile = parsePortableProfile(JSON.stringify(PROFILE));
    expect(profile.networks[0]).toMatchObject({ name: "Libera.Chat", port: 6697 });
    expect(profile.notifications.highlightWords).toEqual(["deploy"]);
  });

  it("refuses a file that is not JSON", () => {
    expect(() => parsePortableProfile("not json")).toThrow(/not valid JSON/);
  });

  it("refuses another JSON format", () => {
    expect(() => parsePortableProfile('{"format":"elsewhere","version":1}')).toThrow(
      /not an ircx profile/,
    );
  });

  it("refuses a profile from a newer format", () => {
    expect(() => parsePortableProfile(JSON.stringify({ ...PROFILE, version: 2 }))).toThrow(
      /supports version 1/,
    );
  });

  it("names an invalid network port", () => {
    const profile = structuredClone(PROFILE);
    profile.networks[0]!.port = 70_000;
    expect(() => parsePortableProfile(JSON.stringify(profile))).toThrow(/invalid port: 70000/);
  });
});

describe("profile import planning", () => {
  it("updates a network by name without dropping destination-only fields", async () => {
    listNetworkConfigs.mockResolvedValue([
      {
        id: "destination-id",
        name: "Libera.Chat",
        host: "old.example",
        port: 6697,
        tls: true,
        tlsVerify: true,
        clientCertificate: "/keys/client.pem",
        nick: "old",
        altNicks: [],
        username: "old",
        realname: "Old",
        sasl: { mechanism: "PLAIN", account: "sable", password: null },
        connectCommands: ["MODE sable +i"],
        autojoin: [],
        autoConnect: false,
        socks5Proxy: null,
        quitMessage: null,
        partMessage: null,
        awayMessage: null,
      },
    ]);

    const plan = await prepareProfileImport(JSON.stringify(PROFILE));

    expect(plan.networks[0]).toMatchObject({
      action: "update",
      authentication: "ready",
      config: {
        id: "destination-id",
        host: "irc.libera.chat",
        clientCertificate: "/keys/client.pem",
        connectCommands: ["MODE sable +i"],
      },
    });
    expect(plan.mutes).toEqual([{ networkName: "Libera.Chat", target: "#noise" }]);
  });

  it("leaves a changed account for manual setup without replacing its stored password", async () => {
    listNetworkConfigs.mockResolvedValue([
      {
        id: "destination-id",
        name: "Libera.Chat",
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        tlsVerify: true,
        clientCertificate: null,
        nick: "sable",
        altNicks: [],
        username: "sable",
        realname: "Sable",
        sasl: { mechanism: "PLAIN", account: "another-account", password: null },
        connectCommands: [],
        autojoin: [],
        autoConnect: true,
        socks5Proxy: null,
        quitMessage: null,
        partMessage: null,
        awayMessage: null,
      },
    ]);

    const plan = await prepareProfileImport(JSON.stringify(PROFILE));
    expect(plan.networks[0]).toMatchObject({
      authentication: "manual",
      config: {
        sasl: { mechanism: "PLAIN", account: "another-account", password: null },
      },
    });
  });

  it("keeps a new network from auto-connecting without its exported password", async () => {
    const plan = await prepareProfileImport(JSON.stringify(PROFILE));
    expect(plan.networks[0]).toMatchObject({
      authentication: "manual",
      config: { sasl: null, autoConnect: false },
    });
  });

  it("reports theme and plugin files that are not installed", async () => {
    const profile = {
      ...structuredClone(PROFILE),
      plugins: [
        {
          id: "greeter",
          name: "Greeter",
          version: "1.0.0",
          grants: { permissions: [], channels: [], hosts: [] },
        },
      ],
    };

    const plan = await prepareProfileImport(JSON.stringify(profile));
    expect(plan.missingThemes).toEqual(["paper"]);
    expect(plan.missingPlugins).toEqual(["Greeter"]);
  });
});
