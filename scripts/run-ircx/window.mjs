#!/usr/bin/env node
// Drives the assembled app — Rust backend, WebKitGTK window — on its own Xvfb,
// and answers on stdin the way driver.mjs does.
//
// driver.mjs is the one to reach for. It runs the frontend in Chrome, where a
// selector reaches an element and the DevTools Protocol answers questions. This
// one is for what only the real app can show: a live socket, the delivery
// states behind it, and anything the Rust side decides.
//
// What it cannot do, because nothing answers for WebKitGTK here:
//
//   * No selectors. The window is read by screenshot and clicked by coordinate.
//   * A coordinate goes stale. The timeline moves under a control while you are
//     aiming at it — take the shot, click, and let nothing arrive in between.
//
// Commands, one per line on stdin, one `ok`/`err` line back:
//
//   type <text>          insert text at the focus, a keystroke at a time
//   key <combo>          Return, Escape, ctrl+k, shift+Return
//   click <x> <y>        window coordinates, the window being at the origin
//   wheel <x> <y> <n>    scroll there, n notches, up when negative
//   ss <file>            screenshot the display to <file> (PNG)
//   wait <ms>
//   quit
//
// Options:
//
//   --server <host:port>   default 127.0.0.1:6667
//   --nick <nick>          default walker
//   --join <#channel>      seeded as a connect command, repeatable
//   --tls                  the seeded network uses TLS, off by default
//   --sasl <account:pass>  the seeded network logs in with SASL PLAIN, which is
//                          what a walk needs to be two sessions of one account
//   --release              drive the release app, built by `npm run tauri build`,
//                          which is what a figure has to be measured on
//   --keep                 leave the profile behind and print where it is
//   --profile <dir>        launch on a profile a --keep run left, as it stands,
//                          which is how "does it survive a restart" is asked
//
// Needs `gcc`, `libXtst`, `Xvfb`, `xprop` and ImageMagick's `import`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SKILL_DIR, "..", "..");
/* The default, which is this worktree's own. `CARGO_TARGET_DIR` is still
 * honoured for anyone who has set one, but SKILL.md no longer tells callers to
 * point it at another checkout — a shared target directory hands this script
 * whichever checkout built last, and the binary it launches is then not the
 * tree being walked. */
const TARGET = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target");

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}
function flags(name) {
  return process.argv.flatMap((arg, at) => (arg === `--${name}` ? [process.argv[at + 1]] : []));
}

const [HOST, PORT] = (flag("server", "127.0.0.1:6667") ?? "").split(":");
const NICK = flag("nick", "walker");
const CHANNELS = flags("join");
const TLS = process.argv.includes("--tls");
/* The password does not go in the seed: the app keeps it in the OS keyring and
 * reads it from there, so a walk has to put it where the app will look — the
 * `ircx` service, under the network's id. */
const [SASL_ACCOUNT, SASL_PASSWORD] = (flag("sasl", "") ?? "").split(":");
const KEEP = process.argv.includes("--keep");
/* A release app carries the frontend inside it and needs no dev server, so this
 * drives what people actually run rather than a debug binary against Vite. Any
 * figure — memory, startup, size — has to come from it; the debug build is for
 * behaviour only. */
const RELEASE = process.argv.includes("--release");
const BINARY = join(TARGET, RELEASE ? "release" : "debug", "ircx");

/* The window is 1200x800 in src-tauri/tauri.conf.json and there is no window
 * manager to place it, so it sits at the origin. A screen of the same size
 * makes a screenshot the window and a click coordinate the window's own. */
const WIDTH = 1200;
const HEIGHT = 800;

function need(binary) {
  if (spawnSync("sh", ["-c", `command -v ${binary}`]).status !== 0) {
    throw new Error(`${binary} is not installed`);
  }
}
["gcc", "Xvfb", "xprop", "import"].forEach(need);
if (SASL_ACCOUNT) need("secret-tool");

/* `npm run tauri build`, and not `cargo build --release`: what decides whether
 * the frontend is inside the binary or fetched from the dev server is the tauri
 * CLI rather than the cargo profile, and both land at this same path. A window
 * driven against the cargo one shows `Could not connect to localhost` on a
 * white page — nothing here can tell them apart, since the embedded assets are
 * compressed, so the first screenshot is what says which you have. */
const BUILD_RELEASE = "run: npm run tauri build -- --no-bundle";

if (!existsSync(BINARY)) {
  /* Built rather than demanded, for the debug binary — it is a minute. A
   * release build is `lto = true` and several. */
  if (RELEASE) throw new Error(`no release binary at ${BINARY} — ${BUILD_RELEASE}`);
  say("ok building the app, which takes a while the first time");
  const built = spawnSync(
    "cargo",
    ["build", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml"), "--no-default-features"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (built.status !== 0) throw new Error("cargo build failed");
}


/* A profile from an earlier `--keep` run, launched again as it stands. Whether
 * something survives a restart — a draft, a pane layout, a theme and its edits
 * — cannot be asked of a profile that is seeded fresh every time, and that is
 * the shape half of `docs/manual-verification.md` is written in. */
const REUSE = flag("profile", null);

const run = mkdtempSync(join(tmpdir(), "ircx-window-"));
const XSEND = join(run, "xsend");
const compiled = spawnSync("gcc", ["-O2", "-o", XSEND, join(SKILL_DIR, "xsend.c"), "-lX11", "-lXtst"], {
  stdio: ["ignore", "ignore", "inherit"],
});
if (compiled.status !== 0) throw new Error("could not build xsend — is libXtst installed?");

/** A display number nothing else is holding. */
function freeDisplay() {
  for (let n = 90; n < 130; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  throw new Error("no free X display between :90 and :130");
}
const DISPLAY = `:${freeDisplay()}`;
const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`], {
  stdio: ["ignore", "ignore", "pipe"],
});
/* Nothing here wants Xvfb's warnings, but a pipe nobody reads is not the same
 * as a closed one: node backs stdio pipes with socketpairs, so the warnings sit
 * in a buffer that fills. Xvfb starts by running xkbcomp and waiting for it,
 * and xkbcomp's own keymap warnings are enough to fill it on a host that also
 * has something to say about its GPU. It then blocks in a write forever, Xvfb
 * waits on it forever, and the display accepts no connections — so every later
 * `xprop` hangs rather than failing, and the run makes no progress and no
 * error. Drained, not ignored: an Xvfb that dies still says why. */
xvfb.stderr.resume();
await sleep(700);

/* GTK prefers Wayland when WAYLAND_DISPLAY is set, so an app started with
 * DISPLAY alone opens on the operator's real desktop while this Xvfb stays
 * black and nothing says why. #347. */
const { WAYLAND_DISPLAY: _wayland, ...inherited } = process.env;
const HOME_DIR = REUSE ?? join(run, "data");
const appEnv = { ...inherited, DISPLAY, GDK_BACKEND: "x11", XDG_DATA_HOME: HOME_DIR };
const ARCHIVE = join(HOME_DIR, "chat.ircx.app", "ircx.sqlite3");

const children = [];
/** The app's own complaints, kept so a launch that never draws a window can
 * report what it said instead of only that it timed out — it refuses a dev
 * server belonging to another checkout, and says so on the way out. #233. */
let appSaid = "";
function startApp() {
  const app = spawn(BINARY, [], { env: appEnv, stdio: ["ignore", "ignore", "pipe"] });
  appSaid = "";
  app.stderr.on("data", (chunk) => (appSaid += chunk.toString()));
  children.push(app);
  return app;
}

/** Whether the window has mapped. Polled rather than waited on: the app says
 * nothing on stdout when its window appears. */
function windowUp() {
  return spawnSync("xprop", ["-name", "ircx"], { env: { ...process.env, DISPLAY } }).status === 0;
}
async function waitForWindow(what, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (windowUp()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}\n${appSaid.trim()}`);
}

/* Vite serves the frontend a debug binary loads: tauri.conf.json pins the port
 * with strictPort, so a dev server from another checkout fails this outright
 * rather than serving somebody else's working tree. #233. A release build reads
 * none of this — the frontend is inside it.
 *
 * The number is read out of `tauri.conf.json` rather than written here, the way
 * `vite.config.ts` reads it: another session holding 5183 is the reason to move
 * `devUrl`, and a harness that has the old number in it cannot be moved with
 * everything else. */
const DEV_PORT = Number(
  new URL(JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).build.devUrl)
    .port,
);
if (!RELEASE) {
  const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.push(vite);
  await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for the Vite dev server")), 60_000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      /* The served URL rather than the port number: "Port 5183 is already in
       * use" carries the port too, and matching that reports a dev server
       * belonging to another checkout as this one starting up. */
      if (!buffer.includes(`http://localhost:${DEV_PORT}/`)) return;
      clearTimeout(timer);
      resolve();
    };
    vite.stdout.on("data", onData);
    vite.stderr.on("data", onData);
    vite.once("exit", (code) => reject(new Error(`the dev server exited with ${code}\n${buffer}`)));
  });
}

/* A reused profile has its archive and its network already, and seeding a
 * second one would answer a different question than the one being asked. */
if (!REUSE) {
  /* The archive has to exist before a network can go in it, and the app is what
   * creates and migrates it. So: launch once, let it write the file, and stop it
   * again. Onboarding is on screen for those few seconds and is never answered. */
  const first = startApp();
  await waitForWindow("the app to create its profile");
  await waitForSchema();
  first.kill();
  await seedWhenUnlocked();
}

/* The app does not drop its SQLite lock the instant it is killed, and the seed
 * is the next thing that wants the file. The 1500ms this replaced was covering
 * that as well as the migration, so shortening it to a schema check moved the
 * failure rather than fixing it: `database is locked`, one run in ten, under
 * load. Both halves are conditions now and neither is a duration. */
async function seedWhenUnlocked() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      seedNetwork();
      return;
    } catch (e) {
      if (!/locked|busy/i.test(String(e)) || Date.now() > deadline) throw e;
      await sleep(250);
    }
  }
}

/* The window is up before the archive is migrated, so the wait above does not
 * say the table is there. A fixed 1500ms stood in for it and held on an idle
 * machine; under sixteen spinners every walk died on `no such table: networks`
 * before it reached the server, which reads as the app failing under load and
 * is the harness guessing. Waiting for the table rather than for a duration is
 * what makes a loaded walk mean anything.
 *
 * It waits with the app still up, which is the whole of it: the app is what
 * writes the table, so a wait after the kill is a wait on nothing and times out
 * however long it is given. */
async function waitForSchema() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const db = new DatabaseSync(ARCHIVE);
      const [table] = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'networks'")
        .all();
      db.close();
      if (table) return;
    } catch {
      /* The file is not there yet, or is mid-migration. Both are "not ready". */
    }
    if (Date.now() > deadline) throw new Error(`no networks table in ${ARCHIVE} after 30s`);
    await sleep(250);
  }
}

function seedNetwork() {
  const db = new DatabaseSync(ARCHIVE);
  db.prepare(
    `INSERT INTO networks (id, name, host, port, tls, tls_verify, nick, alt_nicks, username,
                           realname, sasl_mechanism, sasl_account, connect_commands, autojoin,
                           auto_connect)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, '[]', 1)`,
  ).run(
    "walk",
    "walk",
    HOST,
    Number(PORT),
    TLS ? 1 : 0,
    0,
    NICK,
    NICK,
    NICK,
    /* JSON, and not the bare word: the column holds a serialised
     * `SaslMechanism`, so `PLAIN` deserialises into nothing and takes the whole
     * network list down with it — the app comes up saying it has no networks
     * configured, with the row sitting in the table. */
    SASL_ACCOUNT ? JSON.stringify("PLAIN") : null,
    SASL_ACCOUNT || null,
    JSON.stringify(CHANNELS.map((channel) => `/join ${channel}`)),
  );
  db.close();
  if (SASL_ACCOUNT) seedPassword();
}

/* `keyring` 3.x names an entry by four attributes and finds it by three of
 * them, so a password written under anything else is a password the app cannot
 * see — and SASL then fails in a way that reads as the server refusing it.
 * `crates/ircx-store/src/credentials.rs` is where `ircx` and the id come from. */
function seedPassword() {
  const stored = spawnSync(
    "secret-tool",
    ["store", "--label=ircx walk", "service", "ircx", "username", "walk",
     "target", "default", "application", "rust-keyring"],
    { input: SASL_PASSWORD },
  );
  if (stored.status !== 0) {
    throw new Error(String(stored.stderr).trim() || "secret-tool store failed");
  }
}

startApp();
await waitForWindow(REUSE ? "the app to come back up on that profile" : "the app to come back with its network");

const xsend = (...args) => {
  const done = spawnSync(XSEND, args, { env: { ...process.env, DISPLAY } });
  if (done.status !== 0) throw new Error(String(done.stderr).trim() || "xsend failed");
};

async function command(line) {
  const [verb, ...rest] = line.trim().split(/\s+/);
  const argument = rest.join(" ");
  switch (verb) {
    case "type":
      xsend("type", argument);
      await sleep(200);
      return "ok typed";
    case "key":
      xsend("key", argument);
      await sleep(250);
      return "ok pressed";
    case "click":
      xsend("click", rest[0], rest[1]);
      await sleep(250);
      return "ok clicked";
    case "move":
      xsend("move", rest[0], rest[1]);
      await sleep(250);
      return "ok moved";
    case "wheel":
      xsend("wheel", rest[0], rest[1], rest[2]);
      await sleep(250);
      return "ok scrolled";
    case "ss": {
      const shot = spawnSync("import", ["-window", "root", argument], {
        env: { ...process.env, DISPLAY },
      });
      if (shot.status !== 0) throw new Error(String(shot.stderr).trim() || "import failed");
      return `ok screenshot ${argument}`;
    }
    case "wait":
      await sleep(Number(argument) || 250);
      return "ok waited";
    default:
      throw new Error(`unknown command ${verb}`);
  }
}

say(`ok ready ${DISPLAY} profile ${HOME_DIR}`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  if (line.trim() === "quit") break;
  try {
    say(await command(line));
  } catch (reason) {
    say(`err ${String(reason.message ?? reason).split("\n")[0]}`);
  }
}

for (const child of children) child.kill();
xvfb.kill();
if (SASL_ACCOUNT && !KEEP) {
  spawnSync("secret-tool", ["clear", "service", "ircx", "username", "walk"]);
}
if (KEEP) say(`ok profile kept at ${HOME_DIR}`);
else rmSync(run, { recursive: true, force: true });
process.exit(0);
