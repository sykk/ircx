// A fake backend for the driver, as a script the page runs before the app.
//
// `vite.browser.config.mjs` rejects every `invoke`, which is what the shell and
// the sheets that need nothing from Rust should be walked against. This answers
// instead, so the timeline, the composer, the panes, the roster and the sheets
// that read something all draw. Everything below is fixed: two channels, a
// query, a long channel with a middle to park in, and a few members.
//
// Things to know before adding a handler:
//
//   - Key it off the *Rust* parameter names. `submit_input` takes `input`, not
//     `text`. A wrong name throws inside the stub and reads like a frontend bug.
//   - Plugin commands arrive as `plugin:<name>|<command>`, and `listen` has to
//     answer with a number or nothing subscribes.
//   - Answer with states the backend can actually produce. A plugin asking to
//     read messages without `access-channels` is refused at install
//     (crates/ircx-plugin/src/manifest.rs), so seeding one draws a grant form
//     that looks broken and is not.
//   - No backticks past this line, comments included: the seed is one template
//     literal, so one ends it and Vite reports a parse error in this file
//     rather than anything about the seed.
//
// Anything with no handler rejects by name, so a walk that reaches past what is
// here says so rather than failing silently.
export const SEED = `
(() => {
  const now = Date.parse("2026-08-01T12:00:00Z");
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();
  const NICKS = ["sable", "marrow", "nyx", "kade", "cinder", "vex"];

  let minted = 0;
  const message = (target, nick, text, offset) => ({
    id: "m" + ++minted,
    idIsLocal: false,
    network: "net1",
    target,
    kind: "privmsg",
    sender: { nick, user: nick, host: "example.net", account: null, isSelf: nick === "walker" },
    timestamp: at(offset),
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
    source: "live",
    via: null,
    annotations: [],
    raisedBy: [],
  });

  // Stands in for what the previewer returns, which is a PNG. Any bytes the
  // window can draw answer the only question the walk asks of it, which is
  // where the peek lands and what it covers. The hashes are percent-encoded
  // because a raw one ends the data URI.
  const PREVIEW =
    "data:image/svg+xml;utf8," +
    "<svg xmlns='http://www.w3.org/2000/svg' width='900' height='600'>" +
    "<rect width='900' height='600' fill='%23223344'/>" +
    "<circle cx='450' cy='300' r='210' fill='%23e0a0c0'/>" +
    "<text x='450' y='318' font-size='60' text-anchor='middle' fill='%23ffffff'>preview</text>" +
    "</svg>";

  const attached = (target, nick, offset) => ({
    ...message(target, nick, "https://files.example/burp-req.png", offset),
    attachments: [{
      url: "https://files.example/burp-req.png",
      filename: "burp-req.png",
      mime: "image/png",
      sizeBytes: 1153433n,
      preview: null,
    }],
  });

  const history = {
    "#ircx": [
      message("#ircx", "sable", "morning", 0),
      message("#ircx", "marrow", "sable: did the pane branch land?", 30),
      message("#ircx", "sable", "marrow: yes, closes from the header now", 60),
      message("#ircx", "nyx", "[topic] release notes", 90),
      attached("#ircx", "nyx", 105),
      message("#ircx", "kade", "i can take those", 120),
      message("#ircx", "walker", "i'll review them", 150),
      message("#ircx", "marrow", "walker: thanks", 180),
    ],
    "#rust": [
      message("#rust", "cinder", "anyone seen the borrow checker error on main?", 0),
      message("#rust", "vex", "cinder: which one", 40),
    ],
    // Long enough to have a middle, which is what parking in history needs.
    "#long": Array.from({ length: 300 }, (_, i) =>
      message("#long", NICKS[i % NICKS.length], "line " + i + " of the backlog", i * 20),
    ),
    // An archive of nothing but presence, which the digest folds into about one
    // row however much of it is read back. A pane with nothing to scroll never
    // asks for the next page, so this is the channel that only reaches the end
    // of its history if the reader goes on asking unprompted — #331.
    // Inside one RUN_MS window on purpose, so the whole archive is a single
    // digest row rather than one per five minutes. That is what a netsplit
    // looks like, and it is the shape that leaves a pane with nothing to
    // scroll however many pages it reads.
    "#split": Array.from({ length: 1200 }, (_, i) => ({
      ...message("#split", "crowd" + i, "*.net *.split", i * 0.05),
      kind: "quit",
    })),
    sable: [
      message("sable", "sable", "got a minute?", 0),
      message("sable", "walker", "sure", 20),
    ],
  };

  const member = (nick, prefixes = [], away = null) => ({
    nick,
    account: null,
    prefixes,
    away,
  });
  const members = {
    // A voiced member, an away member and a nick long enough to reach the
    // roster's ceiling, because the column's width is arithmetic off these.
    "#ircx": [
      member("sable", ["@"]),
      member("marrow", ["+"]),
      member("nyx"),
      member("kade", [], "back later"),
      member("walker"),
      member("wallabywombat"),
    ],
    "#rust": [member("cinder", ["@"]), member("vex"), member("walker")],
    "#long": NICKS.map((nick) => member(nick)),
  };

  const channel = (name, unread, topic) => ({
    network: "net1",
    name,
    topic: topic === undefined ? null : { text: topic, setBy: "sable", setAt: at(-3600) },
    modes: "+nt",
    joined: true,
    memberCount: (members[name] ?? []).length,
    unread,
    highlights: 0,
  });

  const snapshot = {
    networks: [{
      id: "net1",
      name: "ergo",
      host: "127.0.0.1",
      port: 6667,
      tls: false,
      status: { state: "connected" },
      currentNick: "walker",
      sasl: { state: "authenticated", detail: { account: "walker", refused: null } },
      capsEnabled: ["message-tags", "echo-message", "server-time", "chathistory"],
      lagMs: 12,
    }],
    channels: [
      channel("#ircx", 0, "the client"),
      channel("#rust", 2),
      channel("#long", 0),
      channel("#split", 0),
    ],
    queries: [{ network: "net1", nick: "sable", account: "sable", unread: 0, online: true }],
  };

  const drafts = {};
  const grants = { permissions: [], channels: [], hosts: [] };
  let provider = null;

  const handlers = {
    get_snapshot: () => snapshot,
    list_network_configs: () => [],
    // A certificate the walk never has to hold: the fingerprint is what the
    // form draws, and reading a real PEM is a test in ircx-net rather than this.
    certificate_fingerprint: ({ path }) =>
      path.endsWith(".pem")
        ? "4c2c2e3f8b8a5d6e7f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60"
        : Promise.reject(path + " holds no certificate, so there is nothing to present"),
    list_members: ({ channel }) => members[channel] ?? [],
    // Pages backwards the way the archive does. It used to answer nothing at
    // all to a request carrying "before", so no walk could reach a second page
    // and #331 — a pane that stops asking — could not be seen here.
    load_history: ({ req }) => {
      const all = history[req.target] ?? [];
      const found = req.before ? all.findIndex((m) => m.timestamp >= req.before) : -1;
      const to = req.before ? (found === -1 ? all.length : found) : all.length;
      return all.slice(Math.max(0, to - req.limit), to);
    },
    load_preview: ({ url }) => ({
      url,
      filename: "burp-req.png",
      mime: "image/png",
      sizeBytes: 1153433n,
      preview: { dataUri: PREVIEW, width: 900, height: 600 },
    }),
    get_draft: ({ target }) => drafts[target] ?? null,
    set_draft: ({ target, text }) => ((drafts[target] = text), null),
    mark_read: () => null,
    set_typing: () => null,

    archive_summary: () => ({
      messages: 12_480n,
      bytes: 3_145_728n,
      networkDays: 90,
      targetDays: null,
      targetOverride: false,
      removedOnLaunch: 0n,
    }),
    set_retention: () => null,
    export_archive: () => 12_480n,
    delete_archive: () => null,
    search_history: ({ req }) => {
      const needle = (req.query ?? "").toLowerCase();
      if (needle === "") return [];
      return Object.values(history)
        .flat()
        .filter((m) => m.text.toLowerCase().includes(needle))
        .slice(0, 20)
        .map((m) => ({ message: m, snippet: m.text }));
    },

    list_themes: () => [],
    list_plugins: () => [{
      id: "units",
      name: "Units",
      version: "1.0.0",
      description: "Rewrites imperial measurements into metric beside the line.",
      commands: [{ name: "units", summary: "Convert a measurement" }],
      // access-channels is what says *where* reading applies, and a manifest
      // asking to read without it is refused at install, in
      // crates/ircx-plugin/src/manifest.rs. A seed missing it draws a grant
      // form no real plugin could produce.
      requests: {
        permissions: ["read-messages", "access-channels", "annotate-messages"],
        channels: ["#ircx", "#rust"],
        hosts: [],
      },
      grants,
    }],
    plugin_permissions: () => [
      { permission: "read-messages", summary: "Read what people say in the conversations you allow" },
      { permission: "access-channels", summary: "Work in the channels you choose, and no others" },
      { permission: "annotate-messages", summary: "Add a note of its own beside a message" },
      { permission: "network-requests", summary: "Reach the hosts you allow" },
    ],
    set_plugin_grants: ({ grants: allowed }) => ({ ...handlers.list_plugins()[0], grants: allowed }),
    remove_plugin: () => null,

    get_upload_provider: () => provider,
    save_upload_provider: ({ provider: saved }) => ((provider = saved), null),
    remove_upload_provider: () => ((provider = null), null),

    submit_input: ({ target, input }) => {
      if (input.startsWith("/")) {
        const name = input.slice(1).split(" ")[0].toLowerCase();
        const known = ["join", "part", "me", "topic", "nick", "query", "react", "unreact"];
        return known.includes(name)
          ? { kind: "handled" }
          : { kind: "rejected", value: "ircx does not know the command /" + name + "." };
      }
      const sent = message(target, "walker", input, 1000 + minted);
      sent.delivery = { state: "sent" };
      (history[target] ??= []).push(sent);
      return { kind: "sent", value: sent };
    },
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: (callback) => {
      const id = Math.floor(Math.random() * 1e9);
      window["_" + id] = callback;
      return id;
    },
    invoke: (command, args) => {
      const bare = command.replace(/^plugin:[^|]*\\|/, "");
      if (bare === "listen" || bare === "unlisten") return Promise.resolve(0);
      const handler = handlers[bare];
      if (!handler) return Promise.reject("the seed has no handler for " + command);
      try {
        return Promise.resolve(handler(args ?? {}));
      } catch (reason) {
        return Promise.reject(String(reason));
      }
    },
  };
})();
`;
