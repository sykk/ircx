// What a client left open costs after a few hours of traffic. Every other
// figure in the Memory section of `docs/measurements.md` is sampled 45 seconds
// after exec.
//
//   node .claude/skills/run-ircx/soak.mjs --minutes 90 --traffic 20 --quiet-after 60
//
// Runs the assembled release app on an Xvfb through `window.mjs`, against
// `quickserver.mjs` talking into one channel, and samples PSS for every process
// in the tree. Writes a CSV and prints a summary.
//
// The store keeps `TIMELINE_CAP` (10,000) messages a conversation, so the
// interesting part is after the cap is full: a plateau is the store working, a
// line that keeps climbing is not.
//
// `--quiet-after` is what makes the answer readable and the run above sets it.
// A client climbing under load looks the same whether it is holding memory or
// only failing to collect it while busy, and the two separate the instant the
// channel stops talking. The 2026-08-07 run climbed 77 MiB past a full cap and
// returned 71 of them in one sample when it went quiet.

import { spawn } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const MINUTES = Number(flag("minutes", 90));
const TRAFFIC = Number(flag("traffic", 20));
const EVERY = Number(flag("sample", 30)) * 1000;
const PORT = Number(flag("port", 6699));
const OUT = flag("out", "/tmp/ircx-soak.csv");
/** Minutes to let the timeline cap fill before a jump counts as one worth
 * dumping. At `--traffic` a second the cap of 10,000 fills in 10000/traffic. */
const SETTLED = Number(flag("settled", 12));
/** Minutes of traffic before the channel goes quiet for the rest of the run.
 * The quiet tail is what separates memory held from memory not yet collected. */
const QUIET_AFTER = Number(flag("quiet-after", 0));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every descendant of `root`, by walking /proc rather than trusting a name:
 * another worktree may be running its own ircx, and sampling somebody else's
 * would be indistinguishable from a leak in this one. */
function descendants(root) {
  const parent = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      /* comm can contain spaces and brackets, so the fields after it are found
       * from the last ')' rather than by splitting the whole line. */
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(entry), Number(after[1]));
    } catch {
      /* A process that exited between readdir and read. */
    }
  }
  const found = [];
  const walk = (pid) => {
    for (const [child, up] of parent) {
      if (up === pid) {
        found.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return found;
}

/** Which of the three processes this is, from `cmdline` rather than `comm`.
 * `comm` is capped at 15 characters, so both WebKit processes arrive truncated
 * — `WebKitWebProces`, `WebKitNetworkPr` — and matching their real names there
 * silently counts neither, which reads as a Rust-only application rather than
 * as a bug in the sampler. */
function nameOf(pid) {
  try {
    const argv0 = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
    return argv0 ? argv0.slice(argv0.lastIndexOf("/") + 1) : null;
  } catch {
    return null;
  }
}

/** PSS in MiB, or null if the process has gone. Pss is the figure to quote for
 * a WebKitGTK app: three processes share a great deal of mapped library, and
 * adding their RSS counts those pages three times. */
function pssOf(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const line = /^Pss:\s+(\d+) kB$/m.exec(rollup);
    return line ? Number(line[1]) / 1024 : null;
  } catch {
    return null;
  }
}

const INTERESTING = new Set(["ircx", "WebKitWebProcess", "WebKitNetworkProcess"]);

/** Anonymous and file-backed RSS, and the largest single anonymous mapping.
 * PSS says a process grew; this says what grew, which is the difference between
 * reporting a number and being able to act on it. A heap region doubling shows
 * up as a step in `widest`; a cache filling shows up in `anon` with `widest`
 * flat. */
function mappingsOf(pid) {
  let anon = 0;
  let file = 0;
  let widest = 0;
  let named = false;
  for (const line of readFileSync(`/proc/${pid}/smaps`, "utf8").split("\n")) {
    if (/^[0-9a-f]+-[0-9a-f]+ /.test(line)) {
      /* The pathname is the 6th field and is absent for anonymous mappings. */
      named = line.trim().split(/\s+/).length > 5;
      continue;
    }
    const kb = /^(Anonymous|Rss):\s+(\d+) kB$/.exec(line);
    if (!kb) continue;
    const mib = Number(kb[2]) / 1024;
    if (kb[1] === "Anonymous") {
      anon += mib;
      if (!named && mib > widest) widest = mib;
    } else if (named) {
      file += mib;
    }
  }
  return { anon, file, widest };
}

const quick = spawn(
  process.execPath,
  [
    join(SKILL_DIR, "quickserver.mjs"),
    "--port",
    String(PORT),
    "--traffic",
    String(TRAFFIC),
    "--quiet-after",
    String(QUIET_AFTER),
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((resolve) => quick.stdout.once("data", resolve));
quick.stdout.resume();

/* window.mjs owns the Xvfb, the profile and the launch; this only watches. It
 * blocks on stdin between commands, so sending it nothing is what keeps the app
 * up — and `quit` at the end is what makes it kill its own children. Killing it
 * instead orphans the app and the Xvfb. */
const window_ = spawn(
  process.execPath,
  [
    join(SKILL_DIR, "window.mjs"),
    "--release",
    "--server",
    `127.0.0.1:${PORT}`,
    "--join",
    "#soak",
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
let ready = "";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`window.mjs never came up:\n${ready}`)), 300_000);
  window_.stdout.on("data", (chunk) => {
    ready += chunk.toString();
    if (/ok ready/.test(ready)) {
      clearTimeout(timer);
      resolve();
    }
  });
});
writeFileSync(OUT, "minute,whole,ircx,WebKitWebProcess,WebKitNetworkProcess,anon,file,widest\n");
process.stdout.write(`ok sampling every ${EVERY / 1000}s for ${MINUTES}m into ${OUT}\n`);

const started = Date.now();
const samples = [];
/* Kept so a jump can be dumped from both sides: the interesting question about
 * a step is which mapping appeared, and that is a diff rather than a number. */
let lastSmaps = null;
let dumped = 0;
while (Date.now() - started < MINUTES * 60_000) {
  const byName = { ircx: 0, WebKitWebProcess: 0, WebKitNetworkProcess: 0 };
  let whole = 0;
  let alive = 0;
  let shape = { anon: 0, file: 0, widest: 0 };
  let webPid = null;
  for (const pid of descendants(window_.pid)) {
    const name = nameOf(pid);
    if (!name || !INTERESTING.has(name)) continue;
    const pss = pssOf(pid);
    if (pss === null) continue;
    alive++;
    byName[name] += pss;
    whole += pss;
    if (name === "WebKitWebProcess") {
      webPid = pid;
      try {
        shape = mappingsOf(pid);
      } catch {
        /* Gone between the two reads. */
      }
    }
  }
  const before = samples[samples.length - 1];
  /* Not while the cap is still filling: loading the page is a jump of its own
   * and would spend every dump on the one part already understood. */
  const settled = before && before.minute > SETTLED;
  if (webPid && settled && byName.WebKitWebProcess - before.WebKitWebProcess > 25 && dumped < 4) {
    dumped++;
    try {
      const now = readFileSync(`/proc/${webPid}/smaps`, "utf8");
      if (lastSmaps) writeFileSync(`${OUT}.step${dumped}.before.smaps`, lastSmaps);
      writeFileSync(`${OUT}.step${dumped}.after.smaps`, now);
      process.stdout.write(`  dumped smaps either side of a ${(byName.WebKitWebProcess - before.WebKitWebProcess).toFixed(1)} MiB jump\n`);
    } catch {
      /* Gone between the two reads. */
    }
  }
  if (webPid) {
    try {
      lastSmaps = readFileSync(`/proc/${webPid}/smaps`, "utf8");
    } catch {
      lastSmaps = null;
    }
  }
  /* Three processes or the sample is not the application. A WebKit process that
   * crashed and did not come back would otherwise look like memory freed. */
  if (alive !== 3) process.stdout.write(`  warn ${alive} processes, expected 3\n`);
  if (!alive) {
    process.stdout.write("err the app is gone\n");
    break;
  }
  const minute = (Date.now() - started) / 60_000;
  samples.push({ minute, whole, ...byName, ...shape });
  appendFileSync(
    OUT,
    `${minute.toFixed(1)},${whole.toFixed(1)},${byName.ircx.toFixed(1)},` +
      `${byName.WebKitWebProcess.toFixed(1)},${byName.WebKitNetworkProcess.toFixed(1)},` +
      `${shape.anon.toFixed(1)},${shape.file.toFixed(1)},${shape.widest.toFixed(1)}\n`,
  );
  process.stdout.write(
    `  ${minute.toFixed(1)}m whole ${whole.toFixed(1)} MiB` +
      ` (ircx ${byName.ircx.toFixed(1)}, web ${byName.WebKitWebProcess.toFixed(1)},` +
      ` net ${byName.WebKitNetworkProcess.toFixed(1)})` +
      ` anon ${shape.anon.toFixed(0)} file ${shape.file.toFixed(0)} widest ${shape.widest.toFixed(0)}\n`,
  );
  await sleep(EVERY);
}

window_.stdin.write("quit\n");
/* Long enough for it to kill the app, stop the Xvfb and delete the profile. */
await sleep(8000);
window_.kill();
quick.kill();

if (samples.length > 2) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  /* The last half is where a plateau shows: the first is the cap filling, which
   * is the store working rather than anything worth reporting as growth. */
  const half = samples.slice(Math.floor(samples.length / 2));
  const slope =
    (half[half.length - 1].whole - half[0].whole) /
    Math.max(1e-9, half[half.length - 1].minute - half[0].minute);
  process.stdout.write(
    `\nok ${samples.length} samples over ${last.minute.toFixed(1)}m\n` +
      `  whole ${first.whole.toFixed(1)} MiB -> ${last.whole.toFixed(1)} MiB\n` +
      `  second half: ${slope >= 0 ? "+" : ""}${slope.toFixed(3)} MiB/min\n`,
  );
}
