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

/**
 * The rows the conversations scope draws: what the manifest listed, then the
 * conversations the reader is in, then anything they have named that is in
 * neither.
 *
 * The reader's own are offered only where naming is allowed. A manifest that
 * listed its channels has already said which ones, and a row outside that list
 * is one `Grants::within` refuses — offering it would be offering a save that
 * cannot happen.
 */
export function offeredChannels(
  asked: readonly string[],
  chosen: readonly string[],
  present: readonly string[],
): string[] {
  const rows = [...asked];
  for (const channel of allowsNaming(asked) ? [...present, ...chosen] : chosen) {
    if (channel !== EVERY_CONVERSATION && !rows.includes(channel)) rows.push(channel);
  }
  return rows;
}

export function toggleHost(grants: PluginGrants, host: string): PluginGrants {
  return {
    ...grants,
    hosts: grants.hosts.includes(host)
      ? grants.hosts.filter((held) => held !== host)
      : [...grants.hosts, host],
  };
}

/** Sending and reading are scoped by `access-channels` rather than by a list of
 * their own, so either one without it reaches nothing. A manifest asking for
 * one without the other is refused, so this is always fixable by ticking it. */
const NEEDS_CHANNELS: PluginPermission[] = ["send-messages", "read-messages"];

/** Whether this permission is one that `access-channels` says where for. */
export function needsChannels(permission: PluginPermission): boolean {
  return NEEDS_CHANNELS.includes(permission);
}

/** Whether a conversation has actually been chosen for the two permissions
 * that are scoped by one. */
export function reachesAnyChannel(grants: PluginGrants): boolean {
  return grants.permissions.includes("access-channels") && grants.channels.length > 0;
}

/** True while an allowed permission reaches nothing — a scope left empty, or
 * sending and reading with no conversation to do it in. Either way it is a
 * grant that gives nothing while reading as though it gives something. */
export function unscoped(grants: PluginGrants): boolean {
  const reaches = reachesAnyChannel(grants);
  return grants.permissions.some((permission) => {
    const scope = scopeOf(permission);
    if (scope !== null) return grants[scope].length === 0;
    return needsChannels(permission) && !reaches;
  });
}

/** Whether the user handed over fewer conversations or websites than the
 * manifest asked for. Counting permissions alone would call a plugin narrowed
 * from every conversation to one "granted everything it asked for". */
function narrowed(plugin: InstalledPlugin): boolean {
  const { grants, requests } = plugin;
  const lostWildcard =
    requests.channels.includes(EVERY_CONVERSATION) &&
    !grants.channels.includes(EVERY_CONVERSATION);
  return (
    lostWildcard ||
    grants.channels.length < requests.channels.length ||
    grants.hosts.length < requests.hosts.length
  );
}

/** How much of what it asked for a plugin holds, for its row in the list. */
export function grantLine(plugin: InstalledPlugin): string {
  const held = plugin.grants.permissions.length;
  const asked = plugin.requests.permissions.length;
  if (held === 0) return "Granted nothing";
  if (held < asked) return `Granted ${held} of ${asked} permissions`;
  return narrowed(plugin)
    ? "Granted every permission, in fewer places than it asked for"
    : "Granted everything it asked for";
}

/**
 * What the status bar says about the installed plugins.
 *
 * The count is of plugins the user can actually reach. Custom slash commands
 * are the one extension point built, so a plugin without `add-commands` has
 * nothing anyone can invoke however much else it was allowed — counting it
 * would read as working.
 */
export function pluginStatus(plugins: readonly InstalledPlugin[]): {
  text: string;
  detail: string;
} {
  if (plugins.length === 0) return { text: "Plugins 0", detail: "No plugins installed" };

  const named = plugins.map((plugin) => `${plugin.name} ${plugin.version}`).join(", ");
  const idle = plugins.filter(
    (plugin) => !plugin.grants.permissions.includes("add-commands"),
  );
  if (idle.length === 0) return { text: `Plugins ${plugins.length}`, detail: named };

  return {
    text: `Plugins ${plugins.length - idle.length} of ${plugins.length}`,
    detail: `${named} · ${idle
      .map((plugin) => plugin.name)
      .join(", ")} cannot be used until granted a command`,
  };
}
