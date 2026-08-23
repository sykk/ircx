/**
 * A stripe down the left of every message, in a colour that names it.
 *
 * #602 is the window drawing messages the DOM does not have there, and a walk
 * of the assembled app has no selectors to catch it with: what it holds is a
 * screenshot of a channel whose lines all look alike. A stripe whose colour is
 * the message's own turns that screenshot into a reading — the colours down a
 * pane are the messages the engine painted, in the order it painted them, and a
 * run that skips or repeats is the defect without anybody having to read prose
 * off a PNG.
 *
 * **Compiled out unless the build asked for it**, the way `@/lib/probe` is:
 * `VITE_SWATCH=1` at build time is what turns it on, and without it `ON` is a
 * false constant and the call below is a branch the minifier drops.
 *
 * The number comes out of the text because diagnostic profiles prefix seeded
 * messages with values such as `line 0613`. A message that carries no such
 * number is left unpainted rather than given a colour that means nothing.
 */
const ON = import.meta.env.VITE_SWATCH === "1";

/** `line 0613` → 613, and null for anything else. */
function numbered(el: Element): number | null {
  const found = /line (\d{4})/.exec(el.textContent ?? "");
  return found ? Number(found[1]) : null;
}

/**
 * Paints them, and keeps painting as the timeline draws.
 *
 * A row arrives, is measured and is redrawn over the commits that follow a
 * landing, so a single pass paints the messages of one commit and misses the
 * ones the next brings. The observer is what makes it a stripe per message
 * rather than a stripe per message that happened to be there first.
 */
export function startSwatches(): void {
  if (!ON) return;
  const style = document.createElement("style");
  style.textContent =
    "[data-msgid]{position:relative}" +
    "[data-msgid]::after{content:'';position:absolute;left:0;top:0;bottom:0;width:8px;background:var(--swatch,transparent)}";
  document.head.append(style);

  const paint = () => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-msgid]")) {
      const n = numbered(el);
      // Twelve bits of it, split over two channels, with the third held at 128
      // so a pixel that is not a stripe is not decoded as a message.
      if (n !== null) el.style.setProperty("--swatch", `rgb(${n >> 8},${n & 255},128)`);
    }
  };
  paint();
  new MutationObserver(paint).observe(document.body, { childList: true, subtree: true });
}
