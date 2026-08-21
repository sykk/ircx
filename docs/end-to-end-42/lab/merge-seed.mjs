// Run 40's channel, over the driver's own seed.
//
// `docs/end-to-end-40/seed.py` fills a real `ergo` with it; this mints the same
// lines in the page, so the arrangement #602 lives in can be reached without a
// server, a proxy or a Rust process. The rules are that file's, line for line:
// runs of sixty by one speaker, a declaration every hundredth line, an address
// every thirteenth, and three body lengths so a page is not a stack of rows the
// virtualiser can size from its estimate alone.
//
// It wraps the seed rather than editing it: `get_snapshot` gains a channel and
// `load_history` answers for that channel, and everything else is passed
// through to whatever `seed.mjs` already does.
export const MERGE = `
(() => {
  const TOTAL = 1009;
  const TARGET = "#merge";
  const NICKS = ["historian", "archivist", "curator"];
  const TOPICS = ["heap", "lfi", "tcache"];
  const SHORT = "ack";
  const MEDIUM = "the reader is somewhere above this line and should stay there";
  const LONG =
    "a longer line, wrapping over more than one row, so the page that lands " +
    "above the viewport is not a stack of rows the virtualiser can size from " +
    "its estimate alone and the arithmetic has something to be wrong about";

  const start = Date.parse("2026-08-01T08:00:00Z");
  const body = (n) => (n % 17 === 0 ? LONG : n % 5 === 0 ? SHORT : MEDIUM);
  const speaker = (n) => NICKS[Math.floor(n / 60) % NICKS.length];

  const lines = [];
  let saidBy = null;
  for (let n = 1; n <= TOTAL; n++) {
    const nick = speaker(n);
    let text = "line " + String(n).padStart(4, "0") + " " + body(n);
    if (n % 100 === 0) text = "[" + TOPICS[Math.floor(n / 100) % TOPICS.length] + "] " + text;
    else if (n % 13 === 0 && saidBy !== null && saidBy !== nick) text = saidBy + ": " + text;
    saidBy = nick;
    lines.push({
      id: "g" + n,
      idIsLocal: false,
      network: "net1",
      target: TARGET,
      kind: "privmsg",
      sender: { nick, user: nick, host: "example.net", account: null, isSelf: false },
      timestamp: new Date(start + n * 2000).toISOString(),
      timestampIsLocal: false,
      text,
      tags: [],
      replyTo: null,
      batch: null,
      delivery: { state: "delivered" },
      reactions: [],
      attachments: [],
      encryption: "plaintext",
      raw: "",
      source: "serverHistory",
      via: null,
      annotations: [],
      raisedBy: [],
    });
  }

  const member = (nick) => ({
    nick, user: nick, host: "example.net", account: null,
    prefixes: [], away: false, isSelf: false, bot: false,
  });

  const internals = window.__TAURI_INTERNALS__;
  const seeded = internals.invoke;
  internals.invoke = async (command, args) => {
    if (command === "get_snapshot") {
      const snapshot = await seeded(command, args);
      snapshot.channels.push({
        network: "net1",
        name: TARGET,
        topic: null,
        modes: "+nt",
        joined: true,
        memberCount: NICKS.length,
        unread: 0,
        highlights: 0,
        muted: false,
      });
      return snapshot;
    }
    if (command === "list_members" && args?.channel === TARGET) return NICKS.map(member);
    if (command === "load_history" && args?.req?.target === TARGET) {
      const req = args.req;
      // A page that lands while the pane is at rest, which is what the proxy
      // in \`docs/end-to-end-40\` holds a real server's for. A page answered
      // inside the wheel burst that asked for it is a different walk.
      if (req.before && window.lab?.hold) await new Promise((r) => setTimeout(r, window.lab.hold));
      const to = req.before ? lines.findIndex((m) => m.timestamp >= req.before) : -1;
      const end = to === -1 ? lines.length : to;
      return lines.slice(Math.max(0, end - req.limit), end);
    }
    return seeded(command, args);
  };

  // A swatch per message, in a colour that names it, so a screenshot says which
  // message the engine drew at a pixel while the DOM says which one belongs
  // there. #602 is the two disagreeing, and nothing else in the window can tell
  // a stale region from a correct one — the lines all look alike.
  const swatch = document.createElement("style");
  swatch.textContent =
    "[data-msgid]{position:relative}" +
    "[data-msgid]::after{content:'';position:absolute;left:0;top:0;bottom:0;width:8px;background:var(--lab,transparent)}";

  const numbered = (el) => {
    const found = /line (\\d{4})/.exec(el.textContent ?? "");
    return found ? Number(found[1]) : null;
  };

  window.lab = {
    /** How long a page-back is held before it is answered. */
    hold: 0,
    scroller: (i = 0) => document.querySelectorAll("[data-testid=timeline-scroller]")[i],
    open: (name) => {
      document.querySelector('[aria-label="' + name + '"]').click();
      return name;
    },
    /** Paints the swatches, and says how many it painted. */
    paint: () => {
      if (!swatch.isConnected) document.head.append(swatch);
      let painted = 0;
      for (const el of document.querySelectorAll("[data-msgid]")) {
        const n = numbered(el);
        if (n === null) continue;
        el.style.setProperty("--lab", "rgb(" + (n >> 8) + "," + (n & 255) + ",128)");
        painted++;
      }
      return painted;
    },
    top: (px, i = 0) => {
      window.lab.scroller(i).scrollTop = px;
      return window.lab.scroller(i).scrollTop;
    },
    scrollTop: (i = 0) => window.lab.scroller(i).scrollTop,
    /**
     * Where the DOM says each message's swatch is drawn, in CSS pixels: the
     * message, the x its swatch sits at, and the band of the pane it covers.
     *
     * Measured off the elements rather than hit-tested, so a wrapper over the
     * column cannot answer for them, and clipped to the scroller, so a message
     * half under the composer is read where it is drawn.
     */
    column: (i = 0) => {
      const box = window.lab.scroller(i).getBoundingClientRect();
      const out = [];
      for (const el of window.lab.scroller(i).querySelectorAll("[data-msgid]")) {
        const n = numbered(el);
        const rect = el.getBoundingClientRect();
        // Below the sticky author band, which paints over the top of the
        // pane and is not the message the DOM has there.
        const top = Math.max(rect.top, box.top + 34);
        const bottom = Math.min(rect.bottom, box.bottom);
        if (n === null || bottom - top < 6) continue;
        out.push([n, Math.round(rect.left + 4), Math.round(top), Math.round(bottom)]);
      }
      return JSON.stringify(out);
    },
  };
})();
`;
