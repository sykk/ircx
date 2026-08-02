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
//   --keep                 leave the profile behind and print where it is
//
// Needs `gcc`, `libXtst`, `Xvfb`, `xprop` and ImageMagick's `import`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SKILL_DIR, "..", "..", "..");
/* A fresh worktree rebuilds ~51G of dependencies, so SKILL.md has callers point
 * CARGO_TARGET_DIR at an existing checkout's target. The binary is then not
 * where ROOT would put it. */
const TARGET = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target");
const BINARY = join(TARGET, "debug", "ircx");

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
const KEEP = process.argv.includes("--keep");

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

if (!existsSync(BINARY)) {
  say("ok building the app, which takes a while the first time");
  const built = spawnSync(
    "cargo",
    ["build", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml"), "--no-default-features"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (built.status !== 0) throw new Error("cargo build failed");
}

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
await sleep(700);

/* GTK prefers Wayland when WAYLAND_DISPLAY is set, so an app started with
 * DISPLAY alone opens on the operator's real desktop while this Xvfb stays
 * black and nothing says why. #347. */
const { WAYLAND_DISPLAY: _wayland, ...inherited } = process.env;
const HOME_DIR = join(run, "data");
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

/* Vite serves the frontend the binary loads: tauri.conf.json pins port 5183
 * with strictPort, so a dev server from another checkout fails this outright
 * rather than serving somebody else's working tree. #233. */
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
children.push(vite);
await new Promise((resolve, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("timed out waiting for the Vite dev server")), 60_000);
  const onData = (chunk) => {
    buffer += chunk.toString();
    /* The served URL rather than the port number: "Port 5183 is already in use"
     * carries the port too, and matching that reports a dev server belonging to
     * another checkout as this one starting up. */
    if (!/http:\/\/localhost:5183\//.test(buffer)) return;
    clearTimeout(timer);
    resolve();
  };
  vite.stdout.on("data", onData);
  vite.stderr.on("data", onData);
  vite.once("exit", (code) => reject(new Error(`the dev server exited with ${code}\n${buffer}`)));
});

/* The archive has to exist before a network can go in it, and the app is what
 * creates and migrates it. So: launch once, let it write the file, and stop it
 * again. Onboarding is on screen for those few seconds and is never answered. */
const first = startApp();
await waitForWindow("the app to create its profile");
first.kill();
await sleep(1500);

const db = new DatabaseSync(ARCHIVE);
db.prepare(
  `INSERT INTO networks (id, name, host, port, tls, tls_verify, nick, alt_nicks, username,
                         realname, sasl_mechanism, sasl_account, connect_commands, autojoin,
                         auto_connect)
   VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL, ?, '[]', 1)`,
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
  JSON.stringify(CHANNELS.map((channel) => `/join ${channel}`)),
);
db.close();

startApp();
await waitForWindow("the app to come back with its network");

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
if (KEEP) say(`ok profile kept at ${HOME_DIR}`);
else rmSync(run, { recursive: true, force: true });
process.exit(0);
