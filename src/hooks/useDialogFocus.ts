import { useEffect, useRef, type RefObject } from "react";

/**
 * What the Tab key stops on inside a dialog.
 *
 * A disabled control is excluded because the browser skips it too, and the ends
 * of this list are where the trap turns focus around — a stop the browser would
 * not have made would send it somewhere nothing follows. Nothing in this client
 * hides a control with CSS rather than unmounting it, so a stop found here is a
 * stop that is really there.
 *
 * It is the shorter list of the two. Chrome also stops on a scrollable
 * container carrying no `tabindex` — that is how a keyboard scrolls one — and
 * no selector describes that. The palette's result list is the case in this
 * client, and losing it costs nothing: the results are walked with the arrow
 * keys from the query field, which is what its combobox asks for. A stop
 * missed here is a stop the turn happens before, so the failure is a smaller
 * ring rather than a way out.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** How many dialogs are on screen. Read only to tell a close from a
 * hand-over: see the cleanup below. */
let openDialogs = 0;

/** What opened each dialog on screen, so a dialog opened from another can
 * inherit it. Keyed on the element, which takes itself out when it unmounts. */
const openers = new WeakMap<HTMLElement, Element | null>();

/**
 * Keeps the keyboard inside a modal while it is open, and hands focus back to
 * whatever opened it.
 *
 * `role="dialog" aria-modal="true"` tells a screen reader the rest of the page
 * is not there. Before #399 the Tab key had not been told: eight stops into the
 * appearance sheet and the ninth was the shell behind the scrim, four past that
 * the window's own Close. The palette took two. Closing any of them left focus
 * on `<body>`, so the way back to what you were doing started at the top of the
 * document.
 *
 * Both halves are the browser's own behaviour rather than a fault in the
 * markup, which is why no test caught it: jsdom implements no sequential focus
 * navigation, so a `keydown` of `Tab` moves nothing there and a vitest test
 * cannot see either half. `useDialogFocus.test.tsx` asserts what this hook
 * decides; the walk in `docs/manual-verification.md` is what asserts the
 * behaviour.
 */
export function useDialogFocus(dialog: RefObject<HTMLElement | null>): void {
  /* Read during render, which is the only moment it is still true: an
   * `autoFocus` field inside the dialog has taken focus by the time any effect
   * of this hook runs, and a hook that looked it up there would call the
   * palette's own query field the thing that opened the palette. */
  const opener = useRef(whatOpenedThis());

  useEffect(() => {
    const root = dialog.current;
    if (root === null) return;
    /* Copied rather than read in the cleanup, which is what the exhaustive-deps
     * rule asks for. It is written once during the first render and never
     * again, so the two are the same value. */
    const back = opener.current;
    openers.set(root, back);
    openDialogs += 1;

    /* A dialog with an `autoFocus` field inside it has already taken focus.
     * One without gets it on the container, which is also what puts Escape
     * within reach: React listens at the root of the tree, so a dialog's own
     * key handler only runs for a keystroke that started inside it. */
    if (!root.contains(document.activeElement)) root.focus();

    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) {
        // A dialog with nothing to land on keeps focus on its container rather
        // than handing it to the page it is covering.
        event.preventDefault();
        return;
      }

      /* Only the two ends are taken. In between, the browser's own order is
       * better than anything recomputed here — it accounts for the tabindex
       * values, the shadow content of a control, and the reading order. */
      const here = document.activeElement;
      const leaving = event.shiftKey ? here === first || here === root : here === last;
      if (!leaving) return;

      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };

    root.addEventListener("keydown", trap);
    return () => {
      root.removeEventListener("keydown", trap);
      openDialogs -= 1;

      /* Deferred, and skipped if anything is open by the time it runs.
       *
       * Two things arrive as an unmount that are not a close. `StrictMode`
       * mounts every effect twice, and a synchronous restore here moved focus
       * out of the palette between the two — which is what left the query field
       * unfocused and the container holding it instead. And a sheet opened from
       * the palette unmounts the palette in the same commit, where the sheet
       * is the thing that should have focus rather than what opened it.
       *
       * Both are the same shape: this dialog stops being the open one inside a
       * single commit, so the count is back above zero before a microtask can
       * run. A real close leaves it at zero. */
      queueMicrotask(() => {
        if (openDialogs > 0) return;
        if (back instanceof HTMLElement && back.isConnected) back.focus();
      });
    };
  }, [dialog]);
}

/**
 * What to give focus back to when this dialog closes.
 *
 * Focus sitting inside another dialog means that one is closing to make room
 * for this one — the palette opening a sheet is the everyday case. Its query
 * field will be gone by the time there is anything to go back to, so what
 * opened *it* is inherited instead, and Escape out of a sheet reached through
 * the palette lands on the button the user started from.
 */
function whatOpenedThis(): Element | null {
  const active = document.activeElement;
  const enclosing = active?.closest('[role="dialog"]');
  if (enclosing instanceof HTMLElement) return openers.get(enclosing) ?? null;
  return active;
}
