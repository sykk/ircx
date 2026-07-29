import { useEffect, useMemo, useRef } from "react";
import {
  DEFAULT_BINDINGS,
  bindingMap,
  chordFor,
  isTextEntry,
  type ActionId,
  type Binding,
} from "@/lib/keybindings";
import { useAppStore } from "@/store";
import { splitTargetKey, targetKey, type TargetKey } from "@/store/keys";
import type { AppState } from "@/store/types";

const HISTORY_CAP = 100;

/** Returning `false` declines the chord: the event keeps its default and
 * reaches whatever else is listening. Escape uses this so the composer still
 * sees it when no overlay is open. */
export type HotkeyHandler = (arg: number | undefined) => boolean | void;
export type HotkeyHandlers = Partial<Record<ActionId, HotkeyHandler>>;

export function useHotkeys(
  handlers: HotkeyHandlers,
  bindings: readonly Binding[] = DEFAULT_BINDINGS,
): void {
  const map = useMemo(() => bindingMap(bindings), [bindings]);

  // Held in a ref so a caller passing a fresh handler object each render does
  // not detach and reattach the document listener.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const binding = map.get(chordFor(event));
      if (!binding) return;
      if (!binding.whenTyping && isTextEntry(event.target)) return;

      const handler = latest.current[binding.action];
      if (!handler) return;
      if (handler(binding.arg) === false) return;

      event.preventDefault();
      event.stopPropagation();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [map]);
}

/** The default table wired to the store. Mount once, at the shell root. */
export function useAppHotkeys(bindings: readonly Binding[] = DEFAULT_BINDINGS): void {
  const history = useRef<{ entries: TargetKey[]; index: number }>({
    entries: [],
    index: -1,
  });
  const traversing = useRef(false);

  // Recorded from the store rather than from a render effect: two targets
  // opened in the same tick produce one render but two history entries.
  useEffect(() => {
    return useAppStore.subscribe((state, previous) => {
      if (state.active === previous.active || !state.active) return;
      if (traversing.current) {
        traversing.current = false;
        return;
      }
      const key = targetKey(state.active.network, state.active.target);
      const h = history.current;
      if (h.entries[h.index] === key) return;
      h.entries = [...h.entries.slice(0, h.index + 1), key].slice(-HISTORY_CAP);
      h.index = h.entries.length - 1;
    });
  }, []);

  const handlers = useMemo<HotkeyHandlers>(() => {
    const go = (key: TargetKey | undefined) => {
      if (!key) return;
      useAppStore.getState().setActive(splitTargetKey(key));
    };

    const step = (delta: number, wantsUnread: boolean) => {
      const state = useAppStore.getState();
      const order = orderedTargets(state);
      if (order.length === 0) return;
      const start = startIndex(state, order, delta);

      for (let n = 1; n <= order.length; n++) {
        const at = (((start + delta * n) % order.length) + order.length) % order.length;
        const key = order[at];
        if (!key) continue;
        if (!wantsUnread || unreadCount(state, key) > 0) {
          go(key);
          return;
        }
      }
    };

    const travel = (delta: number) => {
      const h = history.current;
      const next = h.index + delta;
      if (next < 0 || next >= h.entries.length) return;
      h.index = next;
      traversing.current = true;
      go(h.entries[next]);
    };

    return {
      "palette.toggle": () => useAppStore.getState().togglePalette(),
      "search.open": () => useAppStore.getState().toggleSearch(true),
      "drawer.toggle": () => useAppStore.getState().toggleDrawer(),
      "target.previous": () => step(-1, false),
      "target.next": () => step(1, false),
      "target.previousUnread": () => step(-1, true),
      "target.nextUnread": () => step(1, true),
      "target.jump": (arg) => {
        if (arg === undefined) return;
        go(orderedTargets(useAppStore.getState())[arg - 1]);
      },
      "history.back": () => travel(-1),
      "history.forward": () => travel(1),
      "overlay.dismiss": () => {
        const state = useAppStore.getState();
        if (state.paletteOpen) state.togglePalette(false);
        else if (state.searchOpen) state.toggleSearch(false);
        // Nothing of ours is open, so let the composer clear its reply.
        else return false;
      },
    };
  }, []);

  useHotkeys(handlers, bindings);
}

/** Sidebar order: networks as configured, each one's channels then its queries,
 * both by name. Ctrl+1..9 count through this list. */
function orderedTargets(state: AppState): TargetKey[] {
  const order: TargetKey[] = [];
  for (const network of state.networkOrder) {
    const channels = Object.values(state.channels)
      .filter((c) => c.network === network)
      .sort((a, b) => a.name.localeCompare(b.name));
    const queries = Object.values(state.queries)
      .filter((q) => q.network === network)
      .sort((a, b) => a.nick.localeCompare(b.nick));
    for (const c of channels) order.push(targetKey(network, c.name));
    for (const q of queries) order.push(targetKey(network, q.nick));
  }
  return order;
}

/** Position to count from. With nothing active, stepping forward starts before
 * the first target and stepping back starts after the last. */
function startIndex(state: AppState, order: TargetKey[], delta: number): number {
  const at = state.active
    ? order.indexOf(targetKey(state.active.network, state.active.target))
    : -1;
  if (at !== -1) return at;
  return delta > 0 ? -1 : order.length;
}

function unreadCount(state: AppState, key: TargetKey): number {
  return state.channels[key]?.unread ?? state.queries[key]?.unread ?? 0;
}
