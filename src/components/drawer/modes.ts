interface ModeSpec {
  text: string;
  /** The mode consumes one argument from the mode string, as `+k` and `+l` do. */
  param?: boolean;
}

/* Letters as RFC 2811 and the Charybdis family (Libera, OFTC) define them.
 * Servers invent their own, so an unknown letter renders as `+x` instead of
 * being dropped — an operator would rather see a mode they must look up than
 * silently lose it. */
const CHANNEL_MODES: Record<string, ModeSpec> = {
  n: { text: "no external messages" },
  t: { text: "topic locked by ops" },
  m: { text: "moderated" },
  i: { text: "invite only" },
  s: { text: "secret" },
  p: { text: "private" },
  k: { text: "key required", param: true },
  l: { text: "limit", param: true },
  r: { text: "registered channel" },
  R: { text: "registered users only" },
  S: { text: "TLS users only" },
  c: { text: "colour codes stripped" },
  C: { text: "no CTCP" },
  g: { text: "anyone may invite" },
  z: { text: "reduced moderation" },
  f: { text: "overflow forwards to", param: true },
  j: { text: "join throttle", param: true },
  P: { text: "permanent" },
  O: { text: "operators only" },
};

/** `"+ntl 50"` to `["no external messages", "topic locked by ops", "limit 50"]`. */
export function describeModes(modes: string): string[] {
  const [flags, ...params] = modes.trim().split(/\s+/);
  if (!flags) return [];

  const described: string[] = [];
  let nextParam = 0;
  for (const letter of flags) {
    if (letter === "+" || letter === "-") continue;
    const spec = CHANNEL_MODES[letter];
    if (!spec) {
      described.push(`+${letter}`);
      continue;
    }
    if (!spec.param) {
      described.push(spec.text);
      continue;
    }
    const value = params[nextParam++];
    described.push(value ? `${spec.text} ${value}` : spec.text);
  }
  return described;
}
