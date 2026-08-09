import { announceSettings, ipc, onSettingsChanged } from "@/lib/ipc";
import { useAppStore } from "@/store";

/**
 * Reads the words that raise a conversation into the store.
 *
 * The backend keeps them, because the badge is counted there against the
 * session's nick. The client reads them too, for the other half of the same
 * decision: which line to tint, and which word inside it to mark.
 */
export async function loadHighlightWords(): Promise<void> {
  try {
    useAppStore.getState().setHighlightWords(await ipc.highlightWords());
  } catch (reason) {
    // The nick on its own is what the rule was before anybody added a word, so
    // a list that cannot be read leaves the timeline quieter than it should be
    // rather than wrong about who said what.
    console.warn("ircx could not read the words that raise a conversation", reason);
  }
}

/** Says the words changed, so the other window re-reads them. Nothing travels:
 * both windows can ask the same backend. */
export async function announceHighlightWords(): Promise<void> {
  await announceSettings("notifications");
}

/** Re-reads them whenever the other window writes them. Resolves to an
 * unsubscribe function. */
export async function startHighlightSync(): Promise<() => void> {
  try {
    return await onSettingsChanged("notifications", () => void loadHighlightWords());
  } catch (reason) {
    console.warn("ircx could not follow the other window's highlight words", reason);
    return () => {};
  }
}
