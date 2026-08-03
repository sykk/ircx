#!/usr/bin/env node
// Drives the ircx frontend in headless Chrome and answers on stdin.
//
// Zero dependencies on purpose: Node 22+ ships a WebSocket client, and Chrome
// speaks the DevTools Protocol over one, so there is nothing to install and
// nothing to keep in step with the project's package.json. `google-chrome` is
// the only binary this needs.
//
// It starts Vite itself (through vite.browser.config.mjs, which injects the
// Tauri globals the app assumes) so a caller has one process to start and one
// to kill.
//
// Pass `--seeded` to answer `invoke` from seed.mjs instead of rejecting it,
// which is what anything needing a conversation on screen has to be driven with.
//
// Commands, one per line on stdin. Every one prints a single line beginning
// `ok` or `err`, so a caller can pipe a script in and read the results back
// without parsing anything cleverer than that.
//
//   goto <path>            navigate, default /
//   ss <file>              screenshot to <file>
//   eval <expr>            evaluate, print the JSON result
//   text <sel>             textContent of the first match
//   count <sel>            how many match
//   click <sel>            click the first match
//   drag <sel> <dx> <dy>   press at its centre, move, release — a real pointer
//   dragxy <x> <y> <dx> <dy>  the same from a point, for asking what can be hit
//   size <w> <h>           set the viewport, for what a layout does when narrow
//   fill <sel> <value>     set an input's value the way React notices
//   key <combo>            ctrl+k, Escape, Return, a
//   wait <ms>
//   quit
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const SKILL_DIR = fileURLToPath(new URL(".", import.meta.url));
const CONFIG = join(SKILL_DIR, "vite.browser.config.mjs");
const ROOT = join(SKILL_DIR, "..", "..", "..");

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a line matching `re` on either stream, and returns its match. A
 * child that dies first rejects, so a failure to start is reported as itself
 * rather than as a timeout further down. */
function waitForLine(child, re, what, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const found = buffer.match(re);
      if (!found) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      resolve(found);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited with ${code} before ${what}\n${buffer}`));
    });
  });
}

const vite = spawn("npx", ["vite", "--config", CONFIG], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.argv.includes("--seeded")
    ? { ...process.env, IRCX_SEEDED: "1" }
    : process.env,
});
const viteUrl = (await waitForLine(vite, /http:\/\/localhost:(\d+)\//, "the Vite dev server"))[0];

const profile = mkdtempSync(join(tmpdir(), "ircx-chrome-"));
const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    // The window is chrome-less and sized by Tauri; this is close to the
    // default in src-tauri/tauri.conf.json so screenshots look like the app.
    "--window-size=1200,800",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const devtools = (await waitForLine(chrome, /ws:\/\/127\.0\.0\.1:(\d+)\//, "Chrome's debugger"))[1];

/** The page target, asked for over HTTP because the browser-level socket
 * cannot evaluate anything. */
const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Chrome started without a page target");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.error) waiting.reject(new Error(message.error.message));
  else waiting.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send("Page.enable");
await send("Runtime.enable");

/** Press, move and release, in steps rather than one jump: a handler that reads
 * the pointer's position on every move is the thing under test, and a single
 * 300px move would exercise one reading of it. */
async function dragFrom(x, y, dx, dy) {
  const steps = 12;
  const mouse = (type, at, buttons) =>
    send("Input.dispatchMouseEvent", {
      type,
      x: at.x,
      y: at.y,
      button: "left",
      buttons,
      clickCount: 1,
      pointerType: "mouse",
    });

  await mouse("mousePressed", { x, y }, 1);
  for (let step = 1; step <= steps; step++) {
    await mouse("mouseMoved", { x: x + (dx * step) / steps, y: y + (dy * step) / steps }, 1);
    await sleep(16);
  }
  await mouse("mouseReleased", { x: x + dx, y: y + dy }, 0);
  await sleep(250);
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

/* React installs its own setter on the input's value property and listens for
 * the event that follows. Assigning `el.value` writes straight past it, so the
 * DOM shows the new text while React's state keeps the old — the field looks
 * edited and nothing else on the page reacts. Going through the prototype's
 * setter and then dispatching is what a real keystroke amounts to. */
const REACT_FILL = `(sel, value) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error("no element matching " + sel);
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}`;

const KEYS = {
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
};
const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

async function pressKey(combo) {
  let modifiers = 0;
  const parts = combo.split("+");
  const name = parts.pop();
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier ${part}`);
    modifiers |= bit;
  }

  const spec = KEYS[name] ?? {
    key: name,
    code: `Key${name.toUpperCase()}`,
    keyCode: name.toUpperCase().charCodeAt(0),
    // A character only counts as typed when it is unmodified; ctrl+k is a
    // shortcut, not the letter k. `text` is the character the key produced, so
    // only a one-character name has one; CDP refuses a key name there with
    // "Invalid 'text' parameter".
    text: modifiers === 0 && name.length === 1 ? name : undefined,
  };

  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type: type === "keyDown" && spec.text ? "keyDown" : type,
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      ...(type === "keyDown" && spec.text ? { text: spec.text } : {}),
    });
  }
}

async function run(line) {
  const [command, ...rest] = line.trim().split(/\s+/);
  const argument = line.trim().slice(command.length).trim();

  switch (command) {
    case "goto": {
      await send("Page.navigate", { url: `${viteUrl.replace(/\/$/, "")}${argument || "/"}` });
      await sleep(1200);
      return "ok navigated";
    }
    case "ss": {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(argument, Buffer.from(data, "base64"));
      return `ok screenshot ${argument}`;
    }
    case "eval":
      return `ok ${JSON.stringify(await evaluate(argument))}`;
    case "text":
      return `ok ${JSON.stringify(
        await evaluate(`document.querySelector(${JSON.stringify(argument)})?.textContent ?? null`),
      )}`;
    case "count":
      return `ok ${await evaluate(`document.querySelectorAll(${JSON.stringify(argument)}).length`)}`;
    case "click":
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(argument)});
          if (!el) throw new Error("no element matching " + ${JSON.stringify(argument)});
          // A pointer click focuses what it lands on and el.click() does not,
          // which leaves \`type\` inserting at whatever held the focus before.
          el.focus?.();
          el.click(); return true; })()`,
      );
      await sleep(250);
      return "ok clicked";
    /* A real pointer, which `click` is not. `el.click()` dispatches one event
     * and nothing ever moves, so anything driven by pointerdown/move/up — a
     * divider holding `setPointerCapture` — cannot be worked by it at all.
     * These go through the DevTools Protocol, so Chrome synthesises the pointer
     * events from them exactly as it does for a hand on a mouse. */
    case "drag": {
      /* From the end: a selector holds spaces — `[aria-label="Pane width"]` is
       * the one this was written for — and the two deltas do not. */
      const dy = rest.at(-1);
      const dx = rest.at(-2);
      const selector = rest.slice(0, -2).join(" ");
      const at = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("no element matching " + ${JSON.stringify(selector)});
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      await dragFrom(at.x, at.y, Number(dx) || 0, Number(dy) || 0);
      return `ok dragged from ${Math.round(at.x)},${Math.round(at.y)}`;
    }
    /* The same from a point rather than an element, which is the only way to
     * ask whether a target can be hit: a selector always lands dead centre. */
    case "dragxy": {
      const [x, y, dx, dy] = rest.map(Number);
      await dragFrom(x, y, dx || 0, dy || 0);
      return `ok dragged from ${x},${y}`;
    }
    /* The window a layout is asked about. A floor stated as a share of a split
     * behaves differently at 700px than at 1200, and that difference is the
     * whole question in some of these. */
    case "size": {
      const [width, height] = rest.map(Number);
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(400);
      return `ok ${width}x${height}`;
    }
    case "fill": {
      const [selector, ...value] = rest;
      await evaluate(
        `(${REACT_FILL})(${JSON.stringify(selector)}, ${JSON.stringify(value.join(" "))})`,
      );
      await sleep(250);
      return "ok filled";
    }
    /* src/components/onboarding/fields.tsx labels its inputs with a React
     * useId, so the id is generated and there is no CSS selector that reaches
     * a field by the name a person sees. Everything built on those fields —
     * onboarding, the plugin permissions form, the theme token editor — needs
     * this rather than `fill`. */
    case "filllabel": {
      const [label, ...value] = rest;
      await evaluate(
        `(() => {
          const label = [...document.querySelectorAll("label")]
            .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
          if (!label) throw new Error("no field labelled " + ${JSON.stringify(label)});
          const target = document.getElementById(label.htmlFor);
          if (!target) throw new Error("label " + ${JSON.stringify(label)} + " points at nothing");
          return (${REACT_FILL})("#" + CSS.escape(target.id), ${JSON.stringify(value.join(" "))});
        })()`,
      );
      await sleep(250);
      return "ok filled";
    }
    case "key":
      await pressKey(argument);
      await sleep(300);
      return "ok pressed";
    /* Goes to whatever holds focus. Chrome inserts the text the way a real
     * composition does, so React sees it — and unlike a key-by-key sequence it
     * does not depend on the keyboard layout, which is what makes `(` and `)`
     * reachable at all. */
    case "type":
      await send("Input.insertText", { text: argument });
      await sleep(300);
      return "ok typed";
    case "wait":
      await sleep(Number(argument) || 250);
      return "ok waited";
    default:
      throw new Error(`unknown command ${command}`);
  }
}

say(`ok ready ${viteUrl}`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  if (line.trim() === "quit") break;
  try {
    say(await run(line));
  } catch (reason) {
    say(`err ${String(reason.message ?? reason).split("\n")[0]}`);
  }
}

chrome.kill();
vite.kill();
process.exit(0);
