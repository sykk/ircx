import { targetKey, type TargetKey } from "./keys";
import type { AppState } from "./types";

export function nextUnreadTarget(
  state: AppState,
  current: TargetKey | null,
  direction: 1 | -1,
): TargetKey | null {
  const order = orderedTargets(state);
  if (order.length === 0) return null;

  const highlighted = order.filter(
    (key) => key !== current && (state.channels[key]?.highlights ?? 0) > 0,
  );
  const unread = highlighted.length > 0
    ? highlighted
    : order.filter((key) => key !== current && unreadCount(state, key) > 0);
  if (unread.length === 0) return null;

  const currentIndex = current ? order.indexOf(current) : -1;
  const start = currentIndex !== -1 ? currentIndex : direction > 0 ? -1 : order.length;
  for (let step = 1; step <= order.length; step++) {
    const index = (((start + direction * step) % order.length) + order.length) % order.length;
    const key = order[index];
    if (key && unread.includes(key)) return key;
  }
  return null;
}

/** Sidebar order: networks as configured, each one's channels then its queries,
 * both by name. */
export function orderedTargets(state: AppState): TargetKey[] {
  const order: TargetKey[] = [];
  for (const network of state.networkOrder) {
    const channels = Object.values(state.channels)
      .filter((channel) => channel.network === network)
      .sort((a, b) => a.name.localeCompare(b.name));
    const queries = Object.values(state.queries)
      .filter((query) => query.network === network)
      .sort((a, b) => a.nick.localeCompare(b.nick));
    for (const channel of channels) order.push(targetKey(network, channel.name));
    for (const query of queries) order.push(targetKey(network, query.nick));
  }
  return order;
}

function unreadCount(state: AppState, key: TargetKey): number {
  return state.channels[key]?.unread ?? state.queries[key]?.unread ?? 0;
}
