import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";

/** Reads the installed plugins into the store at startup, because the status
 * bar reports them whether or not the sheet has ever been opened. A directory
 * that cannot be read leaves the list empty rather than holding up the window. */
export async function loadPlugins(): Promise<void> {
  try {
    useAppStore.getState().setPlugins(await ipc.listPlugins());
  } catch (reason) {
    console.warn("ircx could not read the installed plugins", reason);
  }
}
