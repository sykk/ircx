/**
 * The mark on a link that leaves ircx.
 *
 * Said before the click rather than reported after it: the reader is deciding
 * whether to follow the link at the moment they are looking at it, and a line
 * that appears afterwards answers a question they have already acted on.
 *
 * Here rather than written twice, so the mark and the words announced with it
 * cannot drift apart between the inline link and the attachment line.
 */
export function LeavesTheClient() {
  return (
    <span aria-hidden="true" className="ml-1 text-[11px] align-baseline">
      ↗
    </span>
  );
}

/** What a screen reader is told instead of the arrow. */
export function leavingLabel(destination: string): string {
  return `${destination}, opens in your browser`;
}
