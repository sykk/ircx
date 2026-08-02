// A fake backend for the driver, as a script the page runs before the app.
//
// `vite.browser.config.mjs` rejects every `invoke`, which is what the shell and
// the sheets that need nothing from Rust should be walked against. This answers
// instead, so the timeline, the composer, the panes, the roster and the sheets
// that read something all draw. Everything below is fixed: two channels, a
// query, a long channel with a middle to park in, and a few members.
//
// Two things to know before adding a handler:
//
//   - Key it off the *Rust* parameter names. `submit_input` takes `input`, not
//     `text`. A wrong name throws inside the stub and reads like a frontend bug.
//   - Plugin commands arrive as `plugin:<name>|<command>`, and `listen` has to
//     answer with a number or nothing subscribes.
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

  const history = {
    "#ircx": [
      message("#ircx", "sable", "morning", 0),
      message("#ircx", "marrow", "sable: did the pane branch land?", 30),
      message("#ircx", "sable", "marrow: yes, closes from the header now", 60),
      message("#ircx", "nyx", "[topic] release notes", 90),
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
      sasl: { state: "authenticated", detail: { account: "walker" } },
      capsEnabled: ["message-tags", "echo-message", "server-time", "chathistory"],
      lagMs: 12,
    }],
    channels: [channel("#ircx", 0, "the client"), channel("#rust", 2), channel("#long", 0)],
    queries: [{ network: "net1", nick: "sable", account: "sable", unread: 0, online: true }],
  };

  const drafts = {};
  const grants = { permissions: [], channels: [], hosts: [] };
  let provider = null;

  const handlers = {
    get_snapshot: () => snapshot,
    list_network_configs: () => [],
    list_members: ({ channel }) => members[channel] ?? [],
    load_history: ({ req }) => (req.before ? [] : (history[req.target] ?? [])),
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
      requests: { permissions: ["read-messages", "annotate-messages"], channels: ["#ircx"], hosts: [] },
      grants,
    }],
    plugin_permissions: () => [
      { permission: "read-messages", summary: "Read what people say in the conversations you allow" },
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
