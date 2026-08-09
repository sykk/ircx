import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { selectActiveTarget } from "@/store/selectors";

/** Mirrors the theme's own keys: state the backend has no reason to know about
 * lives next to the other window state. */
const STORAGE_KEY = "ircx.settings.scope";

/**
 * The conversation the client was on when the settings window was asked for.
 *
 * The Privacy page is the reason this exists. Retention, export and delete are
 * all offered per conversation as well as for the whole archive, and as a
 * sheet that page read the conversation off the store because it was in the
 * window that had one. The settings window does not: it runs no event bridge,
 * so `activeViewId` there is null and every per-conversation control would be
 * gone.
 *
 * Written through localStorage rather than carried in the URL or the event.
 * Both windows are one origin, so this is the hand-off they already use for
 * every appearance setting, and a channel name is `#ircx` — a `#` in a URL is
 * a fragment, and encoding it correctly in Rust to decode it in TypeScript is
 * two more places for a channel called `#c++` to go wrong.
 *
 * It is a snapshot and not a subscription. The page names the conversation it
 * is scoped to, so a client that has moved on since leaves the page accurate
 * about a conversation rather than wrong about the current one.
 */
export interface SettingsScope {
  network: string;
  /** The network as a reader knows it. The id is a hash, and the settings
   * window has no network list of its own to look the name up in. */
  networkName: string;
  /** Null on the server console, and when no conversation is open at all. */
  target: string | null;
}

/**
 * Opens the settings window on a section, taking the conversation with it.
 *
 * The one way the client asks for that window. Three places do — the title
 * bar, the palette and `Mod+,` — and a scope written by two of them and
 * forgotten by the third is a Privacy page that works depending on how it was
 * reached.
 */
export async function openSettingsWindow(section?: string): Promise<void> {
  writeScope(currentScope());
  await ipc.openSettings(section);
}

function currentScope(): SettingsScope | null {
  const state = useAppStore.getState();
  const here = selectActiveTarget(state);
  if (!here) return null;
  return {
    network: here.network,
    networkName: state.networks[here.network]?.name ?? here.network,
    // The server console is not a conversation and has nothing archived under
    // its own name; the network it belongs to is the scope there.
    target: here.target === "" ? null : here.target,
  };
}

function writeScope(scope: SettingsScope | null): void {
  try {
    if (scope === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  } catch {
    /* The Privacy page falls back to the whole archive, which is the same
     * answer it gave when no conversation was open. */
  }
}

/** What the client last wrote, or null. localStorage is a text file the user
 * can edit, so this is untrusted input rather than what was written: anything
 * that is not the shape of a scope is no scope. */
export function readScope(): SettingsScope | null {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    if (held === null) return null;
    const raw: unknown = JSON.parse(held);
    if (typeof raw !== "object" || raw === null) return null;
    const { network, networkName, target } = raw as Record<string, unknown>;
    if (typeof network !== "string" || network === "") return null;
    return {
      network,
      networkName: typeof networkName === "string" && networkName !== "" ? networkName : network,
      target: typeof target === "string" && target !== "" ? target : null,
    };
  } catch {
    return null;
  }
}
