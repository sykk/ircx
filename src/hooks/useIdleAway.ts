import { useEffect, useRef } from "react";
import { ipc } from "@/lib/ipc";

/**
 * What counts as the reader still being at the window.
 *
 * Keyboard and pointer rather than window focus: reading a channel without
 * touching anything is not being here, and a window in the background while
 * somebody types in it is. The events are the ones every input path ends in,
 * listened for on the capture phase so a component stopping propagation for
 * its own reasons does not make the reader disappear.
 */
const ACTIVITY = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

/**
 * How long to sit on a change before reporting it. Pointer movement fires
 * continuously, and a reader who is present is present — there is nothing to
 * say until the answer is different from the last one sent.
 */
export function useIdleAway(afterMinutes: number | null): void {
  // Ref rather than state on purpose: nothing on screen reads this, and the
  // re-render every pointer move would cost the whole window.
  const idle = useRef(false);

  useEffect(() => {
    if (afterMinutes === null || afterMinutes <= 0) {
      // The setting went off while the reader was away, so what this client
      // said on their behalf has to be taken back — leaving it would strand
      // them away with nothing left running to bring them back.
      if (idle.current) {
        idle.current = false;
        void ipc.setIdle(false).catch(() => {});
      }
      return;
    }

    const after = afterMinutes * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function report(next: boolean) {
      if (idle.current === next) return;
      idle.current = next;
      // A failure here is a network that stopped or is busy, and the next
      // change reports again. Saying so louder would be a dialog about a
      // keyboard.
      void ipc.setIdle(next).catch(() => {});
    }

    function wait() {
      clearTimeout(timer);
      timer = setTimeout(() => report(true), after);
    }

    function moved() {
      report(false);
      wait();
    }

    for (const event of ACTIVITY) {
      window.addEventListener(event, moved, { capture: true, passive: true });
    }
    wait();

    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY) {
        window.removeEventListener(event, moved, { capture: true });
      }
    };
  }, [afterMinutes]);
}
