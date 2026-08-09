import { announceSettings, ipc, onSettingsChanged } from "@/lib/ipc";
import { useAppStore } from "@/store";

/**
 * Reads the installed plugins into the store at startup, because the status bar
 * reports them whether or not the sheet has ever been opened.
 *
 * A library that will not open is kept rather than dropped. The backend answers
 * with a sentence written for the user, and "no plugins installed" is a
 * different fact from "your plugins could not be read" — the second one hides
 * every plugin the user has while telling them nothing.
 */
export async function loadPlugins(): Promise<void> {
  try {
    useAppStore.getState().setPlugins(await ipc.listPlugins());
  } catch (reason) {
    useAppStore
      .getState()
      .setPluginsUnavailable(
        typeof reason === "string" && reason.length > 0
          ? reason
          : "The installed plugins could not be read.",
      );
  }
}

/**
 * Says the installed plugins changed, so the other window re-reads them.
 *
 * The list lives in the archive rather than in the window, so unlike an
 * appearance setting there is nothing shared to read back — the receiver asks
 * the backend again. What makes this necessary at all is the status bar: the
 * plugin screens are in the settings window now and the count is in the
 * client's, so an install the client never hears about is a number that stays
 * where it was while the plugin it should count is running.
 */
export async function announcePlugins(): Promise<void> {
  await announceSettings("plugins");
}

/** Re-reads the installed plugins whenever the other window changes them.
 * Resolves to an unsubscribe function. */
export async function startPluginSync(): Promise<() => void> {
  try {
    return await onSettingsChanged("plugins", () => void loadPlugins());
  } catch (reason) {
    console.warn("ircx could not follow the other window's plugins", reason);
    return () => {};
  }
}
