import { useEffect, useMemo, useRef } from "react";
import {
  DEFAULT_BINDINGS,
  bindingMap,
  chordFor,
  isTextEntry,
  type ActionId,
  type Binding,
} from "@/lib/keybindings";
import { selectPresentation } from "@/lib/theme";
import { useAppStore } from "@/store";
import { splitTargetKey, targetKey, type TargetKey } from "@/store/keys";
import { nextUnreadTarget, orderedTargets } from "@/store/unreadNavigation";
import type { ActiveTarget, AppState, ViewId } from "@/store/types";

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
      const now = activeTarget(state);
      if (!now) return;
      const before = activeTarget(previous);
      if (before && before.network === now.network && before.target === now.target) return;
      if (traversing.current) {
        traversing.current = false;
        return;
      }
      const key = targetKey(now.network, now.target);
      const h = history.current;
      if (h.entries[h.index] === key) return;
      h.entries = [...h.entries.slice(0, h.index + 1), key].slice(-HISTORY_CAP);
      h.index = h.entries.length - 1;
    });
  }, []);

  const handlers = useMemo<HotkeyHandlers>(() => {
    const go = (key: TargetKey | undefined) => {
      if (!key) return;
      // Walking the target list moves the pane you are in. `showTarget` would
      // throw focus across the window mid-cycle, which is not what a chord
      // that steps through a list means.
      useAppStore.getState().setActive(splitTargetKey(key));
    };

    const step = (delta: 1 | -1, wantsUnread: boolean) => {
      const state = useAppStore.getState();
      if (wantsUnread) {
        const active = activeTarget(state);
        go(nextUnreadTarget(state, active ? targetKey(active.network, active.target) : null, delta) ?? undefined);
        return;
      }
      const order = orderedTargets(state);
      if (order.length === 0) return;
      const start = startIndex(state, order, delta);

      for (let n = 1; n <= order.length; n++) {
        const at = (((start + delta * n) % order.length) + order.length) % order.length;
        const key = order[at];
        if (!key) continue;
        go(key);
        return;
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

    const walk = (delta: 1 | -1) => {
      const state = useAppStore.getState();
      if (state.viewOrder.length < 2) {
        step(delta, false);
        return;
      }
      const at = state.activeViewId ? state.viewOrder.indexOf(state.activeViewId) : -1;
      const next = state.viewOrder.at((at + delta) % state.viewOrder.length);
      if (next) focusPane(next);
    };

    return {
      "palette.toggle": () => useAppStore.getState().togglePalette(),
      "search.open": () => useAppStore.getState().toggleSearch(true),
      "settings.open": () => useAppStore.getState().openSettings(),
      "roster.toggle": () => {
        const { activeViewId, toggleRoster } = useAppStore.getState();
        if (activeViewId) toggleRoster(activeViewId);
      },
      "timeline.nickEveryLine": () => {
        const { nickEveryLine } = useAppStore.getState().presentation;
        selectPresentation({ nickEveryLine: !nickEveryLine });
      },
      "pane.splitVertical": () => useAppStore.getState().splitActiveView("row"),
      "pane.splitHorizontal": () => useAppStore.getState().splitActiveView("column"),
      "pane.close": () => {
        const state = useAppStore.getState();
        if (!state.activeViewId) return;
        state.closeView(state.activeViewId);
        const focused = useAppStore.getState().activeViewId;
        if (focused) focusPane(focused);
      },
      "pane.previous": () => walk(-1),
      "pane.next": () => walk(1),
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

/** Focuses a pane and takes the caret with it. Moving the store's focus alone
 * would leave the next keystroke going to the pane the user just left. */
function focusPane(id: ViewId): void {
  useAppStore.getState().focusView(id);
  document.querySelector<HTMLTextAreaElement>(`[data-view="${id}"] textarea`)?.focus();
}

/** Position to count from. With nothing active, stepping forward starts before
 * the first target and stepping back starts after the last. */
function startIndex(state: AppState, order: TargetKey[], delta: number): number {
  const active = activeTarget(state);
  const at = active ? order.indexOf(targetKey(active.network, active.target)) : -1;
  if (at !== -1) return at;
  return delta > 0 ? -1 : order.length;
}

/** Where the focused view is looking. The hook form lives in `@/store/selectors`;
 * everything here works off a snapshot rather than a subscription. */
function activeTarget(state: AppState): ActiveTarget | null {
  const view = state.activeViewId ? state.views[state.activeViewId] : undefined;
  if (!view || !view.network) return null;
  return { network: view.network, target: view.target };
}
