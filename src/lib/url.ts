/**
 * How much of the tail is worth reading. Past this the path is scenery: it
 * pushes the host — the part that decides where the link goes — off toward the
 * far end of the measure.
 */
const TAIL_MAX = 28;

export interface LinkLabel {
  /** Host and port, verbatim and never elided. */
  host: string;
  /** Path, query and fragment. Elided past `TAIL_MAX`, empty for a bare host. */
  tail: string;
}

/**
 * A URL split into the part that settles where it goes and the part that does
 * not, so the host can be printed first and at full weight.
 *
 * Parsed rather than sliced, which is the security-relevant half of this.
 * `https://github.com@evil.com/x` reads as GitHub to anyone skimming the raw
 * string; `URL` resolves its host to `evil.com` and that is what gets drawn.
 * The same goes for an international domain, which arrives here already
 * normalised to punycode instead of to the Latin letters it imitates.
 *
 * Null when there is no host to lead with — `mailto:`, a relative path, or
 * anything `URL` refuses. The caller writes those out whole.
 */
export function describeUrl(raw: string): LinkLabel | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname === "") return null;

  const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const tail = rest === "/" ? "" : rest;
  if (tail.length <= TAIL_MAX) return { host, tail };

  // The last segment is the one that usually names the thing. What was dropped
  // is stated rather than trimmed away quietly, and the whole URL stays one
  // hover and one screen reader stop away.
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const kept = last.length > TAIL_MAX - 3 ? `${last.slice(0, TAIL_MAX - 4)}…` : last;
  return { host, tail: `/…/${kept}` };
}
