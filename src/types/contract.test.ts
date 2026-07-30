import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("the IPC contract", () => {
  it("names the server console the same on both sides", () => {
    expect(SERVER_TARGET).toBe(rustConst("crates/ircx-core/src/session.rs", "SERVER_TARGET"));
  });
});
