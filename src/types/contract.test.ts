import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_TARGET } from ".";
import { COMMANDS } from "@/components/composer/commands";

/** Values, unlike types, do not come out of ts-rs. Reading the Rust source is
 * the only way to hold the two halves of one together. */
function rustConst(file: string, name: string): string {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  const match = new RegExp(`const ${name}: &str = "(.*)";`).exec(source);
  if (!match) throw new Error(`${file} no longer declares ${name}`);
  return match[1]!;
}

const SRC = resolve(process.cwd(), "src");
const IPC_FILE = join(SRC, "lib", "ipc.ts");

/**
 * The appearance preview's sample conversation, left out of the scan below.
 *
 * It builds `ChatMessage` literals, so it has to name every required field of
 * one — including the four the window deliberately does not read. Filling a
 * field in is not reading it, and counting it as one would answer four entries
 * of `UNREAD_FIELDS` with a file that only ever writes them.
 */
const PREVIEW_FIXTURE = join(SRC, "components", "settings", "appearance", "previewChannel.ts");

/** Every file the application is built from. Tests and fixtures are left out on
 * purpose: a command only a test calls is still one no user can reach. */
function applicationSources(dir = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...applicationSources(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      entry.name !== "fixtures.ts" &&
      path !== IPC_FILE &&
      path !== PREVIEW_FIXTURE
    ) {
      found.push(path);
    }
  }
  return found;
}

const GENERATED = join(SRC, "types", "generated");
const IPC_CRATE = resolve(process.cwd(), "crates", "ircx-ipc", "src");

/**
 * Why nothing in the window reads a field the backend sends. Every entry has
 * to be a decision somebody made, not a list of things nobody got round to —
 * the test fails if one of these turns out to be read after all, so the list
 * cannot quietly become wallpaper.
 */
const UNREAD_FIELDS: Record<string, string> = {
  batch:
    "The IRCv3 batch id. The timeline groups by time bucket rather than by batch, and the archive keeps it for anything that later wants to.",
  encryption:
    "Always Plaintext this milestone. The field is the extension point, and CLAUDE.md says no encryption UI ships.",
  timestampIsLocal:
    "Whether the time came from server-time or from receipt. Nothing draws the difference between the two.",
  user: "The ident out of the mask. A message is written under a nick; nothing shows the rest of it.",
};

/** Fields declared on the types that cross the boundary, camelCased the way
 * serde renames them. */
function ipcFields(): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (const entry of readdirSync(IPC_CRATE)) {
    if (!entry.endsWith(".rs")) continue;
    const source = readFileSync(join(IPC_CRATE, entry), "utf8");
    for (const struct of source.matchAll(/pub struct (\w+)\s*\{([\s\S]*?)\n\}/g)) {
      for (const field of struct[2]!.matchAll(/^\s*pub (\w+):/gm)) {
        const name = field[1]!.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
        fields.set(name, [...(fields.get(name) ?? []), struct[1]!]);
      }
    }
  }
  return fields;
}

const DISPATCH = resolve(process.cwd(), "crates", "ircx-core", "src", "dispatch.rs");

/**
 * Second names for a command, which `dispatch.rs` answers to and no surface
 * advertises. Offering both spellings of one thing is a longer list saying
 * less.
 */
const ALIASES: Record<string, string> = {
  j: "join",
  leave: "part",
  quote: "raw",
};

/** The commands `/help` prints, which is a third list of the same thing. */
function helpedCommands(): string[] {
  const source = readFileSync(DISPATCH, "utf8");
  const help = source.slice(source.indexOf('const HELP: &str = "'), source.indexOf('this list"'));
  return [...help.matchAll(/^\/([a-z]+)/gm)].map((match) => match[1]!);
}

/** Every name the dispatch table answers to, read off its match arms. */
function dispatchedCommands(): string[] {
  const source = readFileSync(DISPATCH, "utf8");
  const table = source.slice(
    source.indexOf("match name.as_str() {"),
    source.indexOf("is not a command ircx knows"),
  );
  return [...table.matchAll(/"([a-z]+)"/g)].map((match) => match[1]!);
}

/** The command names `ipc` asks the backend for. */
function invokedCommands(): string[] {
  const source = readFileSync(IPC_FILE, "utf8");
  return [...source.matchAll(/invoke<[^>]*>\("([a-z_]+)"/g)].map((match) => match[1]!);
}

/** The command names the backend answers to. */
function registeredCommands(): Set<string> {
  const wiring = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  return new Set([...wiring.matchAll(/commands::(\w+)/g)].map((match) => match[1]!));
}

/** The methods on the `ipc` object, which are the commands the window can run. */
function ipcMethods(source: string): string[] {
  const from = source.indexOf("export const ipc = {");
  const body = source.slice(from, source.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]!);
}

describe("the IPC contract", () => {
  it("names the server console the same on both sides", () => {
    expect(SERVER_TARGET).toBe(rustConst("crates/ircx-core/src/session.rs", "SERVER_TARGET"));
  });

  /**
   * A command with no caller is invisible to both compilers: Rust sees the
   * handler registered, TypeScript sees the method exist. Three of them shipped
   * that way — `close_target`, `remove_network` and disconnect — and each was
   * found by somebody who could not do the thing it does.
   */
  it("has a caller in the application for every command the window can run", () => {
    const source = readFileSync(IPC_FILE, "utf8");
    const called = applicationSources()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    // `ipc` and the method can land on different lines, which the formatter
    // does whenever the chain is long — so a plain substring search reports
    // callers that exist as though they did not.
    const unreachable = ipcMethods(source).filter(
      (method) => !new RegExp(String.raw`\bipc\s*\.\s*${method}\b`).test(called),
    );
    expect(unreachable).toEqual([]);
  });

  /** A name misspelled here fails at runtime and nowhere else: `invoke` takes a
   * string, and the handler list is Rust the frontend never sees. */
  it("invokes only commands the backend registered", () => {
    expect(invokedCommands().length).toBeGreaterThan(0);
    const registered = registeredCommands();
    expect(invokedCommands().filter((name) => !registered.has(name))).toEqual([]);
  });

  /**
   * The window offered `/connect`, `/disconnect` and `/close`, which the
   * dispatch table has no arm for: typing one got "not a command ircx knows"
   * from a list the client itself had drawn. It offered neither `/help` nor
   * `/list`, which it does have. Two hand-kept copies of one list, drifting in
   * both directions at once.
   */
  it("offers exactly the commands the dispatch table answers to", () => {
    const dispatched = dispatchedCommands();
    expect(dispatched.length).toBeGreaterThan(10);

    // A command about the connection is performed by the window: there may be
    // no session to send it to, which is why `/connect` exists at all. It is
    // offered and must *not* be dispatched, or two things would answer it.
    const performed = COMMANDS.filter((command) => command.runs === "connection");
    const sent = COMMANDS.filter((command) => command.runs !== "connection");

    expect(performed.length).toBeGreaterThan(0);
    expect(
      performed.filter((command) => dispatched.includes(command.name)).map((c) => c.name),
    ).toEqual([]);

    const offered = sent.map((command) => command.name);
    const named = new Set([
      ...COMMANDS.map((command) => command.name),
      ...Object.keys(ALIASES),
    ]);

    expect(offered.filter((name) => !dispatched.includes(name))).toEqual([]);
    expect(dispatched.filter((name) => !named.has(name))).toEqual([]);
    // An alias is a second name for something offered, not a way to hide one.
    expect(Object.values(ALIASES).filter((name) => !offered.includes(name))).toEqual([]);

    // `/help` is the third copy, and the only one a user can ask for. It lists
    // what the window performs as well: a reader does not care which layer
    // answers.
    const helped = helpedCommands();
    const performedNames = performed.map((command) => command.name);
    expect(
      helped.filter((name) => !dispatched.includes(name) && !performedNames.includes(name)),
    ).toEqual([]);
    expect(
      COMMANDS.map((command) => command.name).filter((name) => !helped.includes(name)),
    ).toEqual([]);
  });

  /**
   * A Tauri plugin command is allowed by one permission and *scoped* by
   * another. The window had `opener:allow-open-url` and not
   * `opener:allow-default-urls`, so calling it was permitted and every
   * `https://` URL was refused by scope — which is why no link in this client
   * had ever opened.
   *
   * Narrow on purpose. A general check would have to read every plugin's ACL
   * manifest; this asserts the one pairing that has already been wrong.
   */
  it("grants the scope for the opener, not only the command", () => {
    const capability = readFileSync(
      resolve(process.cwd(), "src-tauri", "capabilities", "default.json"),
      "utf8",
    );
    const granted = new Set<string>(JSON.parse(capability).permissions);

    const window = applicationSources()
      .concat(IPC_FILE)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    if (!/\bopenUrl\b/.test(window)) return;
    expect(granted.has("opener:allow-open-url")).toBe(true);
    expect(granted.has("opener:allow-default-urls")).toBe(true);
  });

  /**
   * A field is the third shape this has taken. `part_channel` was a command
   * nothing invoked, `opener:allow-open-url` was a permission nothing called,
   * and `Attachment.mime` was a field nothing read — which is why every URL in
   * a message carried a `fetch` control that could only fail on most of them.
   */
  it("reads every field the backend sends, or says why not", () => {
    const window = [...applicationSources(), IPC_FILE]
      .filter((path) => !path.startsWith(GENERATED))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    // Property access or a destructuring, rather than the bare word: a field
    // called `text` would otherwise match every line in the application.
    const reads = (field: string) =>
      new RegExp(String.raw`\.\s*${field}\b`).test(window) ||
      new RegExp(String.raw`[{,]\s*${field}\s*[,}:=]`).test(window);

    const fields = ipcFields();
    expect(fields.size).toBeGreaterThan(50);

    const unread = [...fields.keys()].filter((field) => !reads(field));
    expect(unread.filter((field) => !(field in UNREAD_FIELDS))).toEqual([]);

    // And the other way: an entry that is read again is a reason nobody needs.
    expect(Object.keys(UNREAD_FIELDS).filter(reads)).toEqual([]);
  });

  /**
   * The same drift in the other direction. A handler nothing invokes compiles,
   * registers and runs; it is simply never reached, which is how `part_channel`
   * and `send_raw` outlived the wrappers that called them.
   *
   * Less costly than a command with no caller — that one is a missing feature,
   * this one is only weight — but it is the same silence, and a check that
   * catches one direction and not the other is half a check.
   */
  it("registers only commands the window invokes", () => {
    const invoked = new Set(invokedCommands());
    expect([...registeredCommands()].filter((name) => !invoked.has(name))).toEqual([]);
  });
});
