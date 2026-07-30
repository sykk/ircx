import type { InstalledPlugin, PluginGrants, PluginPermission } from "@/types";

/** `*` in a grant's channel list: every conversation, private ones included. */
export const EVERY_CONVERSATION = "*";

/** The permissions that mean nothing without saying where they apply. */
const SCOPED: Partial<Record<PluginPermission, "channels" | "hosts">> = {
  "access-channels": "channels",
  "network-requests": "hosts",
};

export function scopeOf(permission: PluginPermission): "channels" | "hosts" | null {
  return SCOPED[permission] ?? null;
}

export function togglePermission(
  grants: PluginGrants,
  permission: PluginPermission,
): PluginGrants {
  if (!grants.permissions.includes(permission)) {
    return { ...grants, permissions: [...grants.permissions, permission] };
  }
  const scope = scopeOf(permission);
  return {
    permissions: grants.permissions.filter((held) => held !== permission),
    // A scope outliving the permission it scopes is a claim on channels or
    // hosts that nothing reads, shown back as a choice the user still holds.
    channels: scope === "channels" ? [] : grants.channels,
    hosts: scope === "hosts" ? [] : grants.hosts,
  };
}

/**
 * `*` stands alone. Named channels beside it would say the user picked them
 * when the wildcard already covers them, and picking one beside `*` narrows
 * nothing — so choosing either kind clears the other.
 */
export function toggleChannel(grants: PluginGrants, channel: string): PluginGrants {
  if (grants.channels.includes(channel)) {
    return { ...grants, channels: grants.channels.filter((held) => held !== channel) };
  }
  if (channel === EVERY_CONVERSATION) {
    return { ...grants, channels: [EVERY_CONVERSATION] };
  }
  return {
    ...grants,
    channels: [...grants.channels.filter((held) => held !== EVERY_CONVERSATION), channel],
  };
}

/**
 * Whether the user may name a conversation the manifest did not list. A plugin
 * asking for `*` asked for all of them, so `Grants::within` takes any single
 * one as less than what it asked for — and narrowing an eager plugin to one
 * channel is the whole point of the scope.
 */
export function allowsNaming(asked: readonly string[]): boolean {
  return asked.includes(EVERY_CONVERSATION);
}

/** The rows the conversations scope draws: what the manifest listed, plus
 * anything the user has named that it did not. */
export function offeredChannels(
  asked: readonly string[],
  chosen: readonly string[],
): string[] {
  const named = chosen.filter(
    (channel) => channel !== EVERY_CONVERSATION && !asked.includes(channel),
  );
  return [...asked, ...named];
}

export function toggleHost(grants: PluginGrants, host: string): PluginGrants {
  return {
    ...grants,
    hosts: grants.hosts.includes(host)
      ? grants.hosts.filter((held) => held !== host)
      : [...grants.hosts, host],
  };
}

/** True while a scoped permission is allowed without a scope: a grant that
 * gives nothing while reading as though it gives something. */
export function unscoped(grants: PluginGrants): boolean {
  return grants.permissions.some((permission) => {
    const scope = scopeOf(permission);
    return scope !== null && grants[scope].length === 0;
  });
}

/** How much of what it asked for a plugin holds, for its row in the list. */
export function grantLine(plugin: InstalledPlugin): string {
  const held = plugin.grants.permissions.length;
  const asked = plugin.requests.permissions.length;
  if (held === 0) return "Granted nothing";
  if (held === asked) return "Granted everything it asked for";
  return `Granted ${held} of ${asked} permissions`;
}

/**
 * What the status bar says about the installed plugins. A plugin holding no
 * permission at all cannot do anything, which is a different thing from one
 * that is working, so the count says how many of them are working.
 */
export function pluginStatus(plugins: readonly InstalledPlugin[]): {
  text: string;
  detail: string;
} {
  if (plugins.length === 0) return { text: "Plugins 0", detail: "No plugins installed" };

  const named = plugins.map((plugin) => `${plugin.name} ${plugin.version}`).join(", ");
  const idle = plugins.filter((plugin) => plugin.grants.permissions.length === 0);
  if (idle.length === 0) return { text: `Plugins ${plugins.length}`, detail: named };

  return {
    text: `Plugins ${plugins.length - idle.length} of ${plugins.length}`,
    detail: `${named} · ${idle.map((plugin) => plugin.name).join(", ")} granted nothing`,
  };
}
