import { chooseFile, ipc } from "@/lib/ipc";

/**
 * Picks a file and offers it to one person.
 *
 * Wrapped rather than written at each of the two menus that offer it, so both
 * name the dialog the same way and neither reaches for a Tauri plugin itself.
 * Does nothing when the picker was dismissed, and rejects with whatever the
 * offer was refused for.
 */
export async function sendFileTo(network: string, nick: string): Promise<void> {
  const path = await chooseFile(`Send a file to ${nick}`, []);
  if (path === null) return;
  await ipc.offerFile(network, nick, path);
}
