import { Icon } from "./Icon";

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
    <span
      className="ml-1 inline-flex translate-y-px align-baseline"
      style={{ color: "var(--accent)" }}
    >
      <Icon name="external" size={11} />
    </span>
  );
}

/** What a screen reader is told instead of the arrow. */
export function leavingLabel(destination: string): string {
  return `${destination}, opens in your browser`;
}
