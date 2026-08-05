// What ircx takes to get on screen, and what a profile with something in it
// adds to that. `docs/measurements.md` measures an empty profile and lists this
// as not measured.
//
//   node .claude/skills/run-ircx/startup.mjs --messages 100000 --networks 3 --runs 3
//
// It drives the real compositor rather than Xvfb, because the figures it has to
// be comparable with were read off `WAYLAND_DEBUG` and a frame commit is not a
// thing an X server reports. So a window appears on the operator's screen once
// per run and goes away again.
//
// Needs `target/release/ircx`, built by `npm run tauri build -- --no-bundle` —
// not `cargo build --release`, which produces a binary that fetches the
// frontend from a dev server and measures an error page. See SKILL.md.

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SKILL_DIR, "..", "..", "..");
const BINARY = join(ROOT, "target", "release", "ircx");

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const MESSAGES = Number(flag("messages", 100_000));
const NETWORKS = Number(flag("networks", 3));
const RUNS = Number(flag("runs", 3));
const PORT = Number(flag("port", 6699));

if (!existsSync(BINARY)) throw new Error(`no ${BINARY} — run: npm run tauri build -- --no-bundle`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The app is what creates and migrates its own archive, so every profile starts
 * by being launched once and stopped again. Onboarding is on screen for those
 * few seconds and is never answered. */
async function freshProfile() {
  const home = mkdtempSync(join(tmpdir(), "ircx-startup-"));
  const archive = join(home, "chat.ircx.app", "ircx.sqlite3");
  const app = spawn(BINARY, [], { env: { ...process.env, XDG_DATA_HOME: home }, stdio: "ignore" });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    /* Migrated, not merely created: the file appears before the schema is in
     * it, and seeding a table that does not exist yet fails intermittently. */
    if (existsSync(archive) && hasSchema(archive)) break;
    await sleep(200);
  }
  await sleep(1200);
  app.kill();
  await sleep(1200);
  if (!hasSchema(archive)) throw new Error("the app never wrote a usable archive");
  return { home, archive };
}

function hasSchema(archive) {
  try {
    const db = new DatabaseSync(archive, { readOnly: true });
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='networks'").get();
    db.close();
    return Boolean(found);
  } catch {
    return false;
  }
}

/* Trigger-maintained FTS means a plain insert builds both search indexes, so an
 * archive seeded here is the one the app would have written.
 *
 * `open_targets` is what makes a populated archive matter at all. Conversations
 * are restored on the connection task, from `drive()` in task.rs, so a network
 * that is not dialling never reads a message however many it has — and one that
 * dials reads a page for each target remembered here. Seeding messages without
 * these rows measures opening a large file and nothing else. */
function seed(archive, { messages, networks, autoConnect }) {
  const db = new DatabaseSync(archive);
  db.exec("PRAGMA journal_mode=WAL");
  /* Every one of these literals is JSON the store parses back, and three of
   * them are not the value their column name suggests: `kind` is a quoted
   * camelCase string, `delivery` is internally tagged, `tags` is an array. A
   * row that gets them wrong inserts perfectly well, counts towards the file
   * size, and then fails to deserialise — so the archive looks populated and
   * the timeline comes up empty. Copied from a row the app wrote itself. */
  const insert = db.prepare(
    `INSERT INTO messages (message_id, server_msgid, network, target, kind, sender_nick,
                           sender_user, sender_host, sender_account, sender_is_self, timestamp,
                           timestamp_is_local, text, tags, reply_to, batch, delivery, attachments,
                           encryption, raw, via)
     VALUES (?, NULL, ?, '#measure', '"privmsg"', ?, 'u', 'h', NULL, 0, ?, 1, ?, '[]', NULL,
             NULL, '{"state":"delivered"}', '[]', '"plaintext"', ?, NULL)`,
  );
  db.exec("BEGIN");
  for (let i = 0; i < messages; i++) {
    const at = new Date(1_700_000_000_000 + i * 1000).toISOString();
    const on = `quick${networks ? i % networks : 0}`;
    const nick = `talker${i % 40}`;
    const text = `line ${i} of the seeded archive`;
    insert.run(`m${i}`, on, nick, at, text, `:${nick}!u@h PRIVMSG #measure :${text}`);
  }
  db.exec("COMMIT");

  const network = db.prepare(
    `INSERT INTO networks (id, name, host, port, tls, tls_verify, nick, alt_nicks, username,
                           realname, sasl_mechanism, sasl_account, connect_commands, autojoin,
                           auto_connect)
     VALUES (?, ?, '127.0.0.1', ?, 0, 0, ?, '[]', ?, ?, NULL, NULL, '[]', '[]', ?)`,
  );
  /* Lowercase: `open_targets` reads anything else as a query, which reopens the
   * conversation in the wrong place and is silent about it. */
  const open = db.prepare("INSERT INTO open_targets (network, target, kind) VALUES (?, '#measure', 'channel')");
  for (let n = 0; n < networks; n++) {
    const nick = `walker${n}`;
    network.run(`quick${n}`, `quick${n}`, PORT, nick, nick, nick, autoConnect ? 1 : 0);
    open.run(`quick${n}`);
  }
  db.close();
}

/** The client's own clock, off the head of a `WAYLAND_DEBUG` line. Its base is
 * not the launcher's, so every mark below is an offset from the first line and
 * exec is added back from the launcher's clock afterwards. */
function timestampOf(line) {
  const at = /^\s*\[\s*([0-9.]+)\]/.exec(line);
  return at ? Number(at[1]) : null;
}

/* The three the compositor can answer for. The window is GTK attaching the
 * first buffer to its surface; the content is WebKit attaching one through EGL,
 * which arrives on its own queue and is the only thing that separates the two. */
const MARKS = [
  ["surface committed, no content yet", (line) => /-> wl_surface#\d+\.commit\(\)/.test(line)],
  ["first frame committed", (line) => /\{Default Queue\}\s+-> wl_surface#\d+\.attach\(wl_buffer#\d+/.test(line)],
  ["webview content committed", (line) => /\{mesa egl surface queue\}\s+-> wl_surface#\d+\.attach\(wl_buffer#\d+/.test(line)],
];

async function once(home) {
  const env = { ...process.env, XDG_DATA_HOME: home, WAYLAND_DEBUG: "1" };
  const marks = {};
  let first = null;
  let execToFirst = null;
  let done;
  const finished = new Promise((resolve) => (done = resolve));

  const startedAt = process.hrtime.bigint();
  const app = spawn(BINARY, [], { env, stdio: ["ignore", "ignore", "pipe"] });

  let buffer = "";
  app.stderr.on("data", (chunk) => {
    /* Taken in the handler rather than off a poll: stderr is unbuffered in C,
     * so the first chunk is the first protocol message plus the pipe, and a
     * 2ms poll would be most of what is being measured. */
    execToFirst ??= Number(process.hrtime.bigint() - startedAt) / 1e6;
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const at = timestampOf(line);
      if (at === null) continue;
      if (first === null) first = at;
      for (const [name, matches] of MARKS) {
        if (marks[name] === undefined && matches(line)) marks[name] = at - first;
      }
      if (marks["webview content committed"] !== undefined) done();
    }
  });

  const timer = setTimeout(done, 60_000);
  await finished;
  /* First paint is not the end of a startup with networks in it: the window is
   * up before any of them has registered. Kept running a little longer so the
   * dialling has somewhere to land. */
  await sleep(2500);
  clearTimeout(timer);
  app.kill();
  await sleep(900);
  const registered = registrations
    .filter((at) => at >= Number(startedAt) / 1e6)
    .map((at) => at - Number(startedAt) / 1e6)
    .sort((a, b) => a - b);
  return { execToFirst, marks, registered };
}

const conditions = [
  { label: "empty profile", messages: 0, networks: 0, autoConnect: false },
  { label: "empty archive, one network, not dialling", messages: 0, networks: 1, autoConnect: false },
  { label: `${MESSAGES} messages, one network, not dialling`, messages: MESSAGES, networks: 1, autoConnect: false },
  { label: `${MESSAGES} messages, ${NETWORKS} networks dialling`, messages: MESSAGES, networks: NETWORKS, autoConnect: true },
];

/* `--seed-only` builds one of these profiles and stops, so the thing being
 * timed can be looked at: `window.mjs --profile <dir> --release` puts it on an
 * Xvfb where a screenshot can say whether the conversation is really on screen.
 * Nothing in the timing above proves a restore happened. */
if (process.argv.includes("--seed-only")) {
  const { home, archive } = await freshProfile();
  seed(archive, { messages: MESSAGES, networks: NETWORKS, autoConnect: true });
  process.stdout.write(`ok profile ${home}\n`);
  process.exit(0);
}

/* Something has to answer the dialling condition, and what it costs is not
 * supposed to be in the number: a real network's registration is mostly the
 * server, which is why the one connect figure in measurements.md says so. */
const quick = spawn(process.execPath, [join(SKILL_DIR, "quickserver.mjs"), "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => quick.stdout.once("data", resolve));

/** When each network finished registering, on the clock the launcher also uses. */
const registrations = [];
let serverBuffer = "";
quick.stdout.on("data", (chunk) => {
  serverBuffer += chunk.toString();
  const lines = serverBuffer.split("\n");
  serverBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const at = /^ok registered \S+ ([0-9.]+)$/.exec(line);
    if (at) registrations.push(Number(at[1]));
  }
});

for (const condition of conditions) {
  const { home, archive } = await freshProfile();
  if (condition.messages || condition.networks) seed(archive, condition);
  const size = statSync(archive).size;
  process.stdout.write(`\n## ${condition.label} — archive ${(size / 1e6).toFixed(1)} MB\n`);
  for (let run = 0; run < RUNS; run++) {
    const result = await once(home);
    /* Every mark is an offset from the first protocol message, and exec is the
     * anchor the table is written against. */
    const fromExec = Object.fromEntries(
      Object.entries(result.marks).map(([name, at]) => [name, at + result.execToFirst]),
    );
    const shown = MARKS.map(([name]) =>
      fromExec[name] === undefined ? `${name} —` : `${name} ${fromExec[name].toFixed(1)}ms`,
    ).join(", ");
    const dialled = result.registered.length
      ? `, registered ${result.registered.map((at) => `${at.toFixed(0)}ms`).join("/")}`
      : "";
    process.stdout.write(
      `  run ${run + 1}: first message ${result.execToFirst.toFixed(1)}ms, ${shown}${dialled}\n`,
    );
  }
  rmSync(home, { recursive: true, force: true });
}

quick.kill();
process.stdout.write("\nok done\n");
