import { ipc } from "@/lib/ipc";
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

/**
 * Reads whose lines never raise the reader into the store.
 *
 * Beside the words above and read for the same two halves of one decision: the
 * badge is counted in Rust, and this copy is what decides the tint and the
 * desktop notification a query would otherwise raise.
 */
export async function loadHushedNicks(): Promise<void> {
  try {
    useAppStore.getState().setHushedNicks(await ipc.hushedNicks());
  } catch (reason) {
    // Hushing nobody is louder than the reader asked for rather than quieter,
    // which is the direction the words fail in too: a list that cannot be read
    // never hides a line somebody wanted.
    console.warn("ircx could not read whose lines never raise a conversation", reason);
  }
}
