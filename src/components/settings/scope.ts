import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/store";
import { selectActiveTarget } from "@/store/selectors";

/**
 * The conversation the settings pages are scoped to.
 *
 * Privacy scopes retention, export and deletion by it, and Notifications
 * scopes muting the same way. Both are asked about "this conversation", and
 * this is what that names.
 *
 * Read out of the store rather than handed over. As a second window these
 * pages had no conversations of their own and the client wrote the answer into
 * localStorage for them; a dialog is over the window that has one, so it asks.
 * It follows the reader as they move between channels, which the snapshot could
 * not: the page names what it is scoped to, and now that stays true.
 */
export interface SettingsScope {
  network: string;
  /** The network as a reader knows it, for a page that has to say which one. */
  networkName: string;
  /** Null on the server console, and when no conversation is open at all. */
  target: string | null;
}

export function useSettingsScope(): SettingsScope | null {
  return useAppStore(
    useShallow((s) => {
      const here = selectActiveTarget(s);
      if (!here) return null;
      return {
        network: here.network,
        networkName: s.networks[here.network]?.name ?? here.network,
        // The server console is not a conversation and has nothing archived
        // under its own name; the network it belongs to is the scope there.
        target: here.target === "" ? null : here.target,
      };
    }),
  );
}
