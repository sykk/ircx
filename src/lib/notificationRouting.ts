import { listen } from "@tauri-apps/api/event";
import { insideTauri, ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";

const OPENED = "ircx://notification-opened";
const CONTEXT = 100;

export interface OpenedNotification {
  network: string;
  target: string;
  messageId: string;
}

export async function openNotification(route: OpenedNotification): Promise<void> {
  const key = targetKey(route.network, route.target);
  let state = useAppStore.getState();
  let found = state.timelines[key]?.messages.some((message) => message.id === route.messageId);

  if (!found) {
    try {
      const messages = await ipc.loadHistoryAround(
        route.network,
        route.target,
        route.messageId,
        CONTEXT,
      );
      found = messages.some((message) => message.id === route.messageId);
      if (found) state.replaceHistory(key, messages);
    } catch (reason) {
      console.warn(`ircx could not load ${route.messageId} from ${route.target}`, reason);
    }
  }

  state = useAppStore.getState();
  state.closeSettings();
  state.togglePalette(false);
  state.closeShortcuts();
  state.closeSearch();
  state.showChannels(null);
  state.showTarget({ network: route.network, target: route.target });
  const view = useAppStore.getState().activeViewId;
  if (found && view !== null) useAppStore.getState().setMessageJump(view, route.messageId);
}

export function startNotificationRouting(): Promise<() => void> {
  if (!insideTauri()) return Promise.resolve(() => {});
  return listen<OpenedNotification>(OPENED, ({ payload }) => {
    void openNotification(payload);
  });
}
