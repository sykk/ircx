import type {
  NetworkConfig,
  PluginGrants,
  SaslMechanism,
  UploadMethod,
  UploadProvider,
} from "@/types";
import { ipc } from "@/lib/ipc";
import { sanitiseNotifications, storeNotifications, type Notifications } from "@/lib/notifications";
import {
  DENSITIES,
  sanitiseOverrides,
  sanitisePresentation,
  sanitiseTypography,
  selectDensity,
  selectOverrides,
  selectPresentation,
  selectSidebarCompact,
  selectTheme,
  selectTypography,
  type DensityId,
  type Overrides,
  type Presentation,
  type Typography,
} from "@/lib/theme";
import { useAppStore } from "@/store";

const PROFILE_VERSION = 1;
const SASL_MECHANISMS = new Set<SaslMechanism>([
  "PLAIN",
  "EXTERNAL",
  "SCRAM-SHA-256",
  "SCRAM-SHA-512",
]);

interface PortableNetwork {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  tlsVerify: boolean;
  socks5Proxy: string | null;
  nick: string;
  altNicks: string[];
  username: string;
  realname: string;
  sasl: { mechanism: SaslMechanism; account: string } | null;
  autojoin: string[];
  autoConnect: boolean;
  quitMessage: string | null;
  partMessage: string | null;
  awayMessage: string | null;
}

interface PortableUploadProvider {
  endpoint: string;
  method: UploadMethod;
  authHeader: string | null;
  s3Region: string | null;
  formField: string | null;
}

interface PortablePlugin {
  id: string;
  name: string;
  version: string;
  grants: PluginGrants;
}

interface PortableProfile {
  networks: PortableNetwork[];
  appearance: {
    theme: string;
    installedThemes: string[];
    density: DensityId;
    presentation: Presentation;
    typography: Typography;
    sidebarCompact: boolean;
    themeOverrides: Overrides;
  };
  notifications: {
    desktop: Notifications;
    highlightWords: string[];
    mutedConversations: { network: string; networkName: string; target: string }[];
  };
  uploadProvider: PortableUploadProvider | null;
  plugins: PortablePlugin[];
}

export interface PlannedNetwork {
  action: "add" | "update";
  config: NetworkConfig;
  authentication: "ready" | "manual";
}

export type PlannedUpload =
  | { action: "unchanged" }
  | { action: "save"; provider: UploadProvider }
  | { action: "manual"; endpoint: string };

export interface ProfileImportPlan {
  profile: PortableProfile;
  networks: PlannedNetwork[];
  mutes: { networkName: string; target: string }[];
  skippedMutes: number;
  selectedThemeAvailable: boolean;
  missingThemes: string[];
  missingPlugins: string[];
  upload: PlannedUpload;
}

export interface ProfileImportSummary {
  added: number;
  updated: number;
  muted: number;
}

export function parsePortableProfile(contents: string): PortableProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("That file is not valid JSON. Choose a profile exported by ircx.");
  }

  const root = record(parsed, "That file is not an ircx profile.");
  if (root.format !== "ircx-profile") {
    throw new Error("That file is not an ircx profile.");
  }
  if (root.version !== PROFILE_VERSION) {
    const found = typeof root.version === "number" ? root.version : "an unknown version";
    throw new Error(
      `That profile uses format version ${found}; this build of ircx supports version ${PROFILE_VERSION}.`,
    );
  }

  const appearance = record(root.appearance, "The profile has no usable appearance settings.");
  const notifications = record(
    root.notifications,
    "The profile has no usable notification settings.",
  );
  const density = requiredString(appearance.density, "appearance density") as DensityId;
  if (!DENSITIES.some((candidate) => candidate.id === density)) {
    throw new Error(`The profile names an unknown appearance density: ${density}.`);
  }

  return {
    networks: requiredArray(root.networks, "networks").map((value, index) =>
      portableNetwork(value, index),
    ),
    appearance: {
      theme: requiredString(appearance.theme, "theme"),
      installedThemes: stringArray(appearance.installedThemes, "installed themes"),
      density,
      presentation: sanitisePresentation(appearance.presentation),
      typography: sanitiseTypography(appearance.typography),
      sidebarCompact: requiredBoolean(appearance.sidebarCompact, "compact sidebar setting"),
      themeOverrides: sanitiseOverrides(appearance.themeOverrides),
    },
    notifications: {
      desktop: sanitiseNotifications(notifications.desktop),
      highlightWords: stringArray(notifications.highlightWords, "highlight words"),
      mutedConversations: requiredArray(
        notifications.mutedConversations,
        "muted conversations",
      ).map((value, index) => {
        const mute = record(value, `Muted conversation ${index + 1} is not usable.`);
        return {
          network: requiredString(mute.network, `muted conversation ${index + 1} network`),
          networkName: requiredString(
            mute.networkName,
            `muted conversation ${index + 1} network name`,
          ),
          target: nullableTarget(mute.target, index),
        };
      }),
    },
    uploadProvider: portableUpload(root.uploadProvider),
    plugins: requiredArray(root.plugins, "plugins").map((value, index) =>
      portablePlugin(value, index),
    ),
  };
}

export async function prepareProfileImport(contents: string): Promise<ProfileImportPlan> {
  const profile = parsePortableProfile(contents);
  const [existing, installedThemes, installedPlugins] = await Promise.all([
    ipc.listNetworkConfigs(),
    ipc.listThemes(),
    ipc.listPlugins(),
  ]);

  const importedNames = new Set<string>();
  const networks = profile.networks.map((network): PlannedNetwork => {
    const folded = network.name.toLowerCase();
    if (importedNames.has(folded)) {
      throw new Error(`The profile contains more than one network named ${network.name}.`);
    }
    importedNames.add(folded);

    const matches = existing.filter((candidate) => candidate.name.toLowerCase() === folded);
    if (matches.length > 1) {
      throw new Error(
        `More than one configured network is named ${network.name}. Rename one before importing this profile.`,
      );
    }
    const held = matches[0];
    const authentication =
      network.sasl === null ||
      (held?.sasl?.mechanism === network.sasl.mechanism &&
        held.sasl.account === network.sasl.account &&
        (network.sasl.mechanism !== "EXTERNAL" || held.clientCertificate !== null))
        ? "ready"
        : "manual";

    return {
      action: held ? "update" : "add",
      authentication,
      config: {
        id: held?.id ?? null,
        name: network.name,
        host: network.host,
        port: network.port,
        tls: network.tls,
        tlsVerify: network.tlsVerify,
        clientCertificate: held?.clientCertificate ?? null,
        nick: network.nick,
        altNicks: network.altNicks,
        username: network.username,
        realname: network.realname,
        // The profile carries the account but not what proves it belongs to
        // the reader. Keep matching destination credentials; a new or changed
        // login waits for the network settings form.
        sasl: held?.sasl ?? null,
        connectCommands: held?.connectCommands ?? [],
        autojoin: network.autojoin,
        autoConnect: authentication === "manual" && held === undefined ? false : network.autoConnect,
        socks5Proxy: network.socks5Proxy,
        quitMessage: network.quitMessage,
        partMessage: network.partMessage,
        awayMessage: network.awayMessage,
      },
    };
  });

  const nameCounts = new Map<string, number>();
  for (const network of profile.networks) {
    const folded = network.name.toLowerCase();
    nameCounts.set(folded, (nameCounts.get(folded) ?? 0) + 1);
  }
  const mutes = profile.notifications.mutedConversations.flatMap((mute) =>
    nameCounts.get(mute.networkName.toLowerCase()) === 1
      ? [{ networkName: mute.networkName, target: mute.target }]
      : [],
  );

  const themeIds = new Set(installedThemes.map((theme) => theme.id));
  const pluginIds = new Set(installedPlugins.map((plugin) => plugin.id));
  const availableThemeIds = new Set(useAppStore.getState().themes.map((theme) => theme.id));

  return {
    profile,
    networks,
    mutes,
    skippedMutes: profile.notifications.mutedConversations.length - mutes.length,
    selectedThemeAvailable: availableThemeIds.has(profile.appearance.theme),
    missingThemes: profile.appearance.installedThemes.filter((id) => !themeIds.has(id)),
    missingPlugins: profile.plugins.filter((plugin) => !pluginIds.has(plugin.id)).map((p) => p.name),
    upload: plannedUpload(profile.uploadProvider),
  };
}

export async function applyProfileImport(plan: ProfileImportPlan): Promise<ProfileImportSummary> {
  const ids = new Map<string, string>();
  for (const network of plan.networks) {
    const id = await ipc.saveNetwork(network.config);
    ids.set(network.config.name.toLowerCase(), id);
  }

  await ipc.setHighlightWords(plan.profile.notifications.highlightWords);
  useAppStore.getState().setHighlightWords(plan.profile.notifications.highlightWords);

  for (const mute of plan.mutes) {
    const network = ids.get(mute.networkName.toLowerCase());
    if (network !== undefined) await ipc.setMuted(network, mute.target || null, true);
  }

  if (plan.upload.action === "save") {
    await ipc.saveUploadProvider(plan.upload.provider);
  }

  const appearance = plan.profile.appearance;
  selectOverrides(appearance.themeOverrides);
  selectDensity(appearance.density);
  selectPresentation(appearance.presentation);
  selectTypography(appearance.typography);
  selectSidebarCompact(appearance.sidebarCompact);
  if (plan.selectedThemeAvailable) selectTheme(appearance.theme);
  storeNotifications(plan.profile.notifications.desktop);

  return {
    added: plan.networks.filter((network) => network.action === "add").length,
    updated: plan.networks.filter((network) => network.action === "update").length,
    muted: plan.mutes.length,
  };
}

function portableNetwork(value: unknown, index: number): PortableNetwork {
  const network = record(value, `Network ${index + 1} is not usable.`);
  const port = requiredNumber(network.port, `network ${index + 1} port`);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Network ${index + 1} has an invalid port: ${port}.`);
  }

  let sasl: PortableNetwork["sasl"] = null;
  if (network.sasl !== null) {
    const held = record(network.sasl, `Network ${index + 1} has unusable SASL settings.`);
    const mechanism = requiredString(
      held.mechanism,
      `network ${index + 1} SASL mechanism`,
    ) as SaslMechanism;
    if (!SASL_MECHANISMS.has(mechanism)) {
      throw new Error(`Network ${index + 1} names an unknown SASL mechanism: ${mechanism}.`);
    }
    sasl = {
      mechanism,
      account: requiredString(held.account, `network ${index + 1} SASL account`, true),
    };
  }

  return {
    name: requiredString(network.name, `network ${index + 1} name`),
    host: requiredString(network.host, `network ${index + 1} host`),
    port,
    tls: requiredBoolean(network.tls, `network ${index + 1} TLS setting`),
    tlsVerify: requiredBoolean(
      network.tlsVerify,
      `network ${index + 1} TLS verification setting`,
    ),
    socks5Proxy: optionalString(network.socks5Proxy, `network ${index + 1} proxy`),
    nick: requiredString(network.nick, `network ${index + 1} nickname`),
    altNicks: stringArray(network.altNicks, `network ${index + 1} alternate nicknames`),
    username: requiredString(network.username, `network ${index + 1} username`, true),
    realname: requiredString(network.realname, `network ${index + 1} real name`, true),
    sasl,
    autojoin: stringArray(network.autojoin, `network ${index + 1} autojoin list`),
    autoConnect: requiredBoolean(
      network.autoConnect,
      `network ${index + 1} auto-connect setting`,
    ),
    quitMessage: optionalString(network.quitMessage, `network ${index + 1} quit message`),
    partMessage: optionalString(network.partMessage, `network ${index + 1} part message`),
    awayMessage: optionalString(network.awayMessage, `network ${index + 1} away message`),
  };
}

function portableUpload(value: unknown): PortableUploadProvider | null {
  if (value === null) return null;
  const upload = record(value, "The upload-provider settings are not usable.");
  const method = requiredString(upload.method, "upload method") as UploadMethod;
  if (method !== "PUT" && method !== "POST") {
    throw new Error(`The profile names an unknown upload method: ${method}.`);
  }
  return {
    endpoint: requiredString(upload.endpoint, "upload endpoint"),
    method,
    authHeader: optionalString(upload.authHeader, "upload authorization header"),
    s3Region: optionalString(upload.s3Region, "upload S3 region"),
    formField: optionalString(upload.formField, "upload form field"),
  };
}

function portablePlugin(value: unknown, index: number): PortablePlugin {
  const plugin = record(value, `Plugin ${index + 1} is not usable.`);
  const grants = record(plugin.grants, `Plugin ${index + 1} has unusable grants.`);
  return {
    id: requiredString(plugin.id, `plugin ${index + 1} id`),
    name: requiredString(plugin.name, `plugin ${index + 1} name`),
    version: requiredString(plugin.version, `plugin ${index + 1} version`),
    grants: {
      permissions: stringArray(grants.permissions, `plugin ${index + 1} permissions`) as PluginGrants["permissions"],
      channels: stringArray(grants.channels, `plugin ${index + 1} channels`),
      hosts: stringArray(grants.hosts, `plugin ${index + 1} hosts`),
    },
  };
}

function plannedUpload(provider: PortableUploadProvider | null): PlannedUpload {
  if (provider === null) return { action: "unchanged" };
  if (provider.authHeader !== null || provider.s3Region !== null || provider.formField !== null) {
    return { action: "manual", endpoint: provider.endpoint };
  }
  return {
    action: "save",
    provider: {
      endpoint: provider.endpoint,
      method: provider.method,
      authHeader: null,
      token: "",
      s3: null,
      form: null,
    },
  };
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`The profile has no usable ${field}.`);
  return value;
}

function requiredString(value: unknown, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && value.trim() === "")) {
    throw new Error(`The profile has no usable ${field}.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`The profile has no usable ${field}.`);
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The profile has no usable ${field}.`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`The profile has no usable ${field}.`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  const list = requiredArray(value, field);
  if (!list.every((entry) => typeof entry === "string")) {
    throw new Error(`The profile has no usable ${field}.`);
  }
  return list as string[];
}

function nullableTarget(value: unknown, index: number): string {
  if (typeof value !== "string") {
    throw new Error(`The profile has no usable muted conversation ${index + 1} target.`);
  }
  return value;
}
