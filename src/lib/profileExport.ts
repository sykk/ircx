import { ipc } from "@/lib/ipc";
import { storedNotifications } from "@/lib/notifications";
import { storedThemeId } from "@/lib/theme/apply";
import { DEFAULT_DENSITY, storedDensity } from "@/lib/theme/density";
import { FALLBACK_THEME_ID } from "@/lib/theme/load";
import { storedOverrides } from "@/lib/theme/overrides";
import { storedPresentation } from "@/lib/theme/presentation";
import { storedSidebarCompact } from "@/lib/theme/sidebar";
import { storedTypography } from "@/lib/theme/typography";
import type { NetworkConfig, UploadProvider } from "@/types";

export const PROFILE_VERSION = 1;

function portableNetwork(config: NetworkConfig) {
  return {
    name: config.name,
    host: config.host,
    port: config.port,
    tls: config.tls,
    tlsVerify: config.tlsVerify,
    socks5Proxy: config.socks5Proxy,
    nick: config.nick,
    altNicks: config.altNicks,
    username: config.username,
    realname: config.realname,
    sasl:
      config.sasl === null
        ? null
        : { mechanism: config.sasl.mechanism, account: config.sasl.account },
    autojoin: config.autojoin,
    autoConnect: config.autoConnect,
    quitMessage: config.quitMessage,
    partMessage: config.partMessage,
    awayMessage: config.awayMessage,
  };
}

function portableUpload(provider: UploadProvider | null) {
  if (provider === null) return null;
  return {
    endpoint: publicEndpoint(provider.endpoint),
    method: provider.method,
    authHeader: provider.authHeader,
    s3Region: provider.s3?.region ?? null,
    formField: provider.form?.fileField ?? null,
  };
}

function publicEndpoint(endpoint: string): string {
  const withoutQuery = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  const scheme = withoutQuery.indexOf("://");
  if (scheme < 0) return withoutQuery;
  const authorityStart = scheme + 3;
  const pathStart = withoutQuery.indexOf("/", authorityStart);
  const authorityEnd = pathStart < 0 ? withoutQuery.length : pathStart;
  const authority = withoutQuery.slice(authorityStart, authorityEnd);
  const credentialEnd = authority.lastIndexOf("@");
  if (credentialEnd < 0) return withoutQuery;
  return `${withoutQuery.slice(0, authorityStart)}${authority.slice(credentialEnd + 1)}${withoutQuery.slice(authorityEnd)}`;
}

export async function buildPortableProfile() {
  const [networks, uploadProvider, themes, plugins, highlightWords, mutedConversations] =
    await Promise.all([
      ipc.listNetworkConfigs(),
      ipc.getUploadProvider(),
      ipc.listThemes(),
      ipc.listPlugins(),
      ipc.highlightWords(),
      ipc.mutedConversations(),
    ]);

  return {
    format: "ircx-profile",
    version: PROFILE_VERSION,
    networks: networks.map(portableNetwork),
    appearance: {
      theme: storedThemeId() ?? FALLBACK_THEME_ID,
      installedThemes: themes.map((theme) => theme.id),
      density: storedDensity() ?? DEFAULT_DENSITY,
      presentation: storedPresentation(),
      typography: storedTypography(),
      sidebarCompact: storedSidebarCompact(),
      themeOverrides: storedOverrides(),
    },
    notifications: {
      desktop: storedNotifications(),
      highlightWords,
      mutedConversations,
    },
    uploadProvider: portableUpload(uploadProvider),
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      grants: plugin.grants,
    })),
    omissions: [
      "Passwords, upload credentials, upload form fields, client-certificate paths, and connect commands are not included.",
      "Message history, drafts, custom theme files, plugin code, and plugin local data are not included.",
    ],
  };
}
