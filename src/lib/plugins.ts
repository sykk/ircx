import { ipc } from "@/lib/ipc";
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
