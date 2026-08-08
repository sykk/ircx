import clsx from "clsx";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { insideTauri } from "@/lib/ipc";

/** `startResizeDragging` takes it but the module does not export it, so it is
 * read back off the method rather than spelled out again here. */
type Direction = Parameters<Window["startResizeDragging"]>[0];

/**
 * The window is `decorations: false`, so the desktop draws no border around it
 * and there is nothing to take hold of: until this shipped the only sizes the
 * window had were the one it opened at and maximised. These are that border —
 * four edges four pixels deep, and four corners of twelve, laid after the edges
 * so a corner wins the pixel both want.
 */
const GRIPS: ReadonlyArray<{ dir: Direction; className: string }> = [
  { dir: "North", className: "top-0 right-3 left-3 h-1 cursor-ns-resize" },
  { dir: "South", className: "right-3 bottom-0 left-3 h-1 cursor-ns-resize" },
  { dir: "West", className: "top-3 bottom-3 left-0 w-1 cursor-ew-resize" },
  { dir: "East", className: "top-3 right-0 bottom-3 w-1 cursor-ew-resize" },
  { dir: "NorthWest", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { dir: "NorthEast", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { dir: "SouthEast", className: "right-0 bottom-0 size-3 cursor-nwse-resize" },
];

/**
 * Aria-hidden throughout, and that is not an oversight: resizing a window from
 * the keyboard is the desktop's job and it already has a way to do it. A
 * separator here would announce a control that answers to nothing.
 */
export function WindowFrame() {
  // In a browser — the dev server, a test — there is no window to resize, and a
  // resize cursor over an edge that does nothing is a worse lie than no cursor.
  if (!insideTauri()) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {GRIPS.map(({ dir, className }) => (
        <div
          key={dir}
          aria-hidden
          data-resize={dir}
          className={clsx("pointer-events-auto absolute", className)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            void getCurrentWindow().startResizeDragging(dir);
          }}
        />
      ))}
    </div>
  );
}
