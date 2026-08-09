import { useLayoutEffect, useRef } from "react";
import { edgeShift } from "./Tooltip";

/** How close to a window edge a menu may sit, and how far it hangs below the
 * button. The first mirrors `EDGE` in ./Tooltip.tsx, which `edgeShift` answers
 * against. */
const EDGE = 8;
const DROP = 4;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Where a menu of this size goes, given the button it hangs from.
 *
 * Right-aligned to the button, below it, then pulled back inside the window on
 * both axes. Kept separate from the hook because this is the whole of the
 * behaviour and a browser is the only place the hook can be seen: jsdom
 * measures every box as zero, so a test driving the component would assert
 * arithmetic on zeroes and pass whatever the answer was.
 */
export function hangingMenuAt(
  anchor: Box,
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const left = anchor.right - menu.width;
  const shift = edgeShift({ left, right: left + menu.width }, view.width);

  const below = anchor.bottom + DROP;
  const fits = below + menu.height <= view.height - EDGE;

  return {
    left: left + shift,
    top: fits ? below : Math.max(EDGE, anchor.top - menu.height - DROP),
  };
}

/**
 * Hangs a menu off whatever it belongs to, inside the window.
 *
 * The sidebar's two menus were both `absolute top-full right-0 w-44`, and both
 * were clipped by the list they hang in — `overflow-y-auto`, and a scroller with
 * one axis not `visible` clips the other too, so neither could escape whatever
 * its coordinates. The network menu was cut off horizontally as well: 176px
 * right-aligned to a button that sits about 137px into a sidebar at its 180px
 * floor drew it from -39px, and the reader saw four labels with their first word
 * missing.
 *
 * Fixed, then, and placed by measurement. `anchorOf` is given the menu and
 * answers with the box to hang it from, because the two callers anchor to
 * different things: the network menu to its own button, so it opens back over
 * the sidebar, and the conversation menu to the row it was right-clicked on,
 * which is the full width of the sidebar. It does not follow the list if that is
 * scrolled under it — neither does the pointer menu — and any click outside
 * closes it first.
 */
export function useHangingMenu(open: boolean, anchorOf: (menu: HTMLElement) => HTMLElement | null) {
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const anchor = anchorOf(node);
    if (!anchor) return;

    const { left, top } = hangingMenuAt(
      anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [open, anchorOf]);

  return menu;
}
