import { useEffect } from "react";
import { ipc } from "@/lib/ipc";

/**
 * Says `message` to a screen reader whenever it becomes something new.
 *
 * The `role="alert"` and `aria-live` markup at the call site stays: it is
 * correct ARIA, it is what a browser reads, and it is what the walk driver
 * asserts. It is simply not enough in this window. WebKitGTK reports nothing
 * for text the page rewrites, and for an alert it does mount it reports an
 * insertion Orca declines — the branch that would present one tests
 * `Role.ALERT` while WebKit maps an ARIA alert to `Role.NOTIFICATION`.
 * `src-tauri/src/announce.rs` and `docs/manual-verification.md` have the
 * measurements.
 *
 * Pass `null` or `""` for nothing to say. Announcing is best-effort — most
 * desktops run no accessibility bus, and there is no backend at all in the
 * browser the frontend is driven in — so a refusal is not an error.
 */
export function useAnnounce(message: string | null | undefined): void {
  useEffect(() => {
    if (message) void ipc.announce(message).catch(() => {});
  }, [message]);
}
