import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_TARGET } from ".";

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
      path !== IPC_FILE
    ) {
      found.push(path);
    }
  }
  return found;
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
    const source = readFileSync(IPC_FILE, "utf8");
    const invoked = [...source.matchAll(/invoke<[^>]*>\("([a-z_]+)"/g)].map((m) => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);

    const wiring = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const registered = new Set(
      [...wiring.matchAll(/commands::(\w+)/g)].map((match) => match[1]!),
    );

    expect(invoked.filter((name) => !registered.has(name))).toEqual([]);
  });
});
