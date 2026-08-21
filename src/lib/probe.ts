import { ipc } from "@/lib/ipc";

/**
 * A line per commit out of the timeline, for #508 — the pane nobody is
 * scrolling that moves one line of text when the other pane pages.
 *
 * Five walks and three test PRs have photographed that pane before and after
 * and never reached a mechanism. What a photograph cannot answer is the one
 * question left: whether `scrollTop` was written to the wrong place, or written
 * to the right one and then the content above the reader grew under it. Both
 * look like a band of text 24px lower. The records here carry the position and
 * the content's size on the same commit, so they are told apart by subtraction.
 *
 * **Compiled out unless the build asked for it.** `VITE_PROBE=1` at build time
 * is what turns this on; without it `ON` is a false constant and every call
 * below is a branch the minifier drops. So the app anybody runs carries no
 * probe, calls no command, and pays nothing — and the build the walk measures
 * is a different build, which is the honest cost of instrumenting from inside.
 *
 * Buffered rather than written through. The records come out of a layout
 * effect, and an IPC call on that path would be an instrument measuring its own
 * weight; a flush every 100ms costs the measured commit a `push`.
 */
const ON = import.meta.env.VITE_PROBE === "1";
/**
 * Whether this build carries the probe, for the call sites whose records cost
 * something to build.
 *
 * `probe` below is a branch the minifier drops; the object handed to it is an
 * argument, and an argument is evaluated whether or not the call does anything.
 * A record that reads the DOM therefore has to be skipped where it is written
 * rather than where it is taken, or the app anybody runs pays for it.
 */
export const probing = ON;
/** How long a record waits for company. */
const FLUSH_MS = 100;

let queue: string[] = [];
let flushing = false;
/** Set when the backend says there is nowhere to write, which is a build with
 * the probe in it running outside a walk. */
let off = false;
let seq = 0;

/**
 * Records one, whatever it is about. `kind` names the site; the rest is the
 * site's own.
 *
 * `n` is written because two flushes could in principle reach the file out of
 * order, and a log whose order is assumed rather than stated cannot be read
 * back against a screenshot. `at` is wall clock, which is what a screenshot's
 * mtime is in.
 */
export function probe(kind: string, record: Record<string, unknown>): void {
  if (!ON || off) return;
  queue.push(JSON.stringify({ n: seq++, at: Date.now(), t: Math.round(performance.now()), kind, ...record }));
  if (!flushing) void flush();
}

async function flush(): Promise<void> {
  flushing = true;
  await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
  const lines = queue;
  queue = [];
  flushing = false;
  if (lines.length === 0) return;
  try {
    await ipc.probe(lines);
  } catch {
    off = true;
  }
}
