import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, NetworkConfig, ThemeSource, UploadProvider } from "@/types";
import type * as Ipc from "@/lib/ipc";
import { buildPortableProfile, PROFILE_VERSION } from "./profileExport";

const listNetworkConfigs = vi.fn<() => Promise<NetworkConfig[]>>();
const getUploadProvider = vi.fn<() => Promise<UploadProvider | null>>();
const listThemes = vi.fn<() => Promise<ThemeSource[]>>();
const listPlugins = vi.fn<() => Promise<InstalledPlugin[]>>();
const highlightWords = vi.fn<() => Promise<string[]>>();
const mutedConversations = vi.fn();

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: {
    listNetworkConfigs: () => listNetworkConfigs(),
    getUploadProvider: () => getUploadProvider(),
    listThemes: () => listThemes(),
    listPlugins: () => listPlugins(),
    highlightWords: () => highlightWords(),
    mutedConversations: () => mutedConversations(),
  },
}));

beforeEach(() => {
  localStorage.clear();
  listNetworkConfigs.mockReset().mockResolvedValue([]);
  getUploadProvider.mockReset().mockResolvedValue(null);
  listThemes.mockReset().mockResolvedValue([]);
  listPlugins.mockReset().mockResolvedValue([]);
  highlightWords.mockReset().mockResolvedValue([]);
  mutedConversations.mockReset().mockResolvedValue([]);
});

describe("portable profile export", () => {
  it("is versioned and carries reader-owned settings", async () => {
    localStorage.setItem("ircx.theme", "ircx-light");
    localStorage.setItem("ircx.density", "compact");
    localStorage.setItem(
      "ircx.notifications",
      JSON.stringify({ highlights: true, directMessages: false }),
    );
    highlightWords.mockResolvedValue(["deploy"]);

    const profile = await buildPortableProfile();

    expect(profile).toMatchObject({
      format: "ircx-profile",
      version: PROFILE_VERSION,
      appearance: { theme: "ircx-light", density: "compact" },
      notifications: {
        desktop: { highlights: true, directMessages: false },
        highlightWords: ["deploy"],
      },
    });
  });

  it("omits credentials, secret-shaped network fields, code, and local data", async () => {
    listNetworkConfigs.mockResolvedValue([
      {
        id: "network-id",
        name: "Libera.Chat",
        host: "irc.libera.chat",
        port: 6697,
        tls: true,
        tlsVerify: true,
        clientCertificate: "/secret/client-key.pem",
        nick: "sable",
        altNicks: [],
        username: "sable",
        realname: "Sable",
        sasl: { mechanism: "PLAIN", account: "sable", password: "network-password" },
        connectCommands: ["msg NickServ identify command-password"],
        autojoin: ["#ircx"],
        autoConnect: true,
        socks5Proxy: "proxy.example.com:1080",
        quitMessage: null,
        partMessage: null,
        awayMessage: null,
      },
    ]);
    getUploadProvider.mockResolvedValue({
      endpoint: "https://endpoint-user:endpoint-password@files.example.com/{name}?token=query-secret",
      method: "PUT",
      authHeader: "Authorization",
      token: "upload-token",
      tokenSaved: true,
      s3: { region: "us-east-1", accessKeyId: "access-key-id" },
      form: { fileField: "upload", fields: [["api_key", "form-secret"]] },
    });
    listThemes.mockResolvedValue([
      {
        id: "paper",
        manifest: "theme-file-secret",
        stylesheet: "css-file-secret",
        uiStylesheet: "ui-file-secret",
      },
    ]);
    listPlugins.mockResolvedValue([
      {
        id: "greeter",
        name: "Greeter",
        version: "1.0.0",
        description: "plugin-code-secret",
        commands: [{ name: "hello", summary: "plugin-data-secret" }],
        requests: { permissions: [], channels: [], hosts: [] },
        grants: { permissions: ["send-messages"], channels: ["#ircx"], hosts: [] },
      },
    ]);

    const json = JSON.stringify(await buildPortableProfile());

    for (const secret of [
      "network-id",
      "/secret/client-key.pem",
      "network-password",
      "command-password",
      "upload-token",
      "access-key-id",
      "endpoint-user",
      "endpoint-password",
      "query-secret",
      "form-secret",
      "theme-file-secret",
      "css-file-secret",
      "ui-file-secret",
      "plugin-code-secret",
      "plugin-data-secret",
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain("proxy.example.com:1080");
    expect(json).toContain('"s3Region":"us-east-1"');
    expect(json).toContain('"endpoint":"https://files.example.com/{name}"');
    expect(json).toContain('"formField":"upload"');
    expect(json).toContain('"installedThemes":["paper"]');
    expect(json).toContain('"id":"greeter"');
  });
});
