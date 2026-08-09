import { useLayoutEffect, useRef, type RefObject } from "react";
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
 * Hangs a menu off a button, inside the window.
 *
 * The sidebar's network menu used to be `absolute top-full right-0 w-44` in the
 * button's own box, which put its left edge 176px to the left of a button that
 * sits about 137px into a sidebar at its 180px floor — so the menu was drawn
 * from -39px and the reader saw four labels with their first word cut off. The
 * list it hangs in is `overflow-y-auto`, and a scroller clips both axes, so an
 * absolute menu could not have escaped even had it fitted the window.
 *
 * Fixed, then, and placed by measurement. It does not follow the list if that
 * is scrolled under it — neither does the pointer menu — and any click outside
 * closes it first.
 */
export function useHangingMenu(open: boolean, anchor: RefObject<HTMLElement | null>) {
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = menu.current;
    const button = anchor.current;
    if (!node || !button) return;

    const { left, top } = hangingMenuAt(
      button.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [open, anchor]);

  return menu;
}
