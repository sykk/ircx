import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NetworkConfig } from "@/types";
import { insideTauri, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";

const IRC_PORT = 6667;
const IRCS_PORT = 6697;
const CHANNEL_PREFIX = /^[#&+!]/;

function invalidTarget(target: string): boolean {
  return [...target].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || character === ",";
  });
}

export interface IrcLink {
  host: string;
  port: number;
  tls: boolean;
  target: string | null;
}

function decodeTarget(url: URL): string | null {
  const path = url.pathname.replace(/^\/+/, "");
  const encoded = path === "" ? url.hash.slice(1) : path;
  if (encoded === "") return null;
  if (path !== "" && url.hash !== "") return null;

  let target: string;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (target === "" || invalidTarget(target)) return null;
  return CHANNEL_PREFIX.test(target) ? target : `#${target}`;
}

export function parseIrcLink(raw: string): IrcLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const tls = url.protocol === "ircs:";
  if (!tls && url.protocol !== "irc:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "") {
    return null;
  }

  const port = url.port === "" ? (tls ? IRCS_PORT : IRC_PORT) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const target = decodeTarget(url);
  const namesTarget = (url.pathname !== "" && url.pathname !== "/") || url.hash !== "";
  if (namesTarget && target === null) return null;

  return { host: url.hostname, port, tls, target };
}

export function networkForIrcLink(
  link: IrcLink,
  configs: readonly NetworkConfig[],
): NetworkConfig | null {
  const host = link.host.toLowerCase();
  return (
    configs.find(
      (config) =>
        config.id !== null &&
        config.host.toLowerCase() === host &&
        config.port === link.port &&
        config.tls === link.tls,
    ) ?? null
  );
}

async function focusWindow(): Promise<void> {
  const window = getCurrentWindow();
  await window.unminimize();
  await window.show();
  await window.setFocus();
}

export async function openIrcLink(link: IrcLink): Promise<void> {
  const configs = await ipc.listNetworkConfigs();
  const config = networkForIrcLink(link, configs);
  if (config === null) {
    useAppStore.getState().openIrcSetup(link);
    await focusWindow();
    return;
  }

  const network = config.id!;
  const store = useAppStore.getState();
  const status = store.networks[network]?.status.state;
  if (status === undefined || status === "disconnected" || status === "failed") {
    await ipc.connectNetwork(network);
  }

  if (link.target === null) {
    store.openConsole(network);
  } else {
    const channel = store.channels[targetKey(network, link.target)];
    if (!channel?.joined) await ipc.joinChannel(network, link.target);
    store.showTarget({ network, target: link.target });
  }
  store.closeSettings();
  store.togglePalette(false);
  store.closeShortcuts();
  store.closeSearch();
  store.showChannels(null);
  await focusWindow();
}

function openLinks(rawUrls: readonly string[], open: (link: IrcLink) => Promise<void>): void {
  for (const raw of rawUrls) {
    const link = parseIrcLink(raw);
    if (link === null) {
      console.warn(`ircx refused an invalid IRC link: ${raw}`);
      continue;
    }
    void open(link).catch((reason: unknown) => {
      console.warn(`ircx could not open ${raw}`, reason);
    });
  }
}

export async function startIrcLinks(open: (link: IrcLink) => Promise<void>): Promise<() => void> {
  if (!insideTauri()) return () => {};

  let current: string[] | null = null;
  try {
    current = await getCurrent();
  } catch (reason) {
    console.warn("ircx could not read the IRC link that opened it", reason);
  }
  if (current !== null) openLinks(current, open);

  try {
    return await onOpenUrl((urls) => openLinks(urls, open));
  } catch (reason) {
    console.warn("ircx could not listen for IRC links", reason);
    return () => {};
  }
}
