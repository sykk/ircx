import { describe, expect, it } from "vitest";
import { cycleCompletion, startCompletion } from "./completion";
import { matchCommands } from "./commands";

const NICKS = ["sable", "sableton", "phrack", "nyx"];

describe("startCompletion", () => {
  it("appends a colon at the start of a line", () => {
    const done = startCompletion("sab", 3, NICKS);
    expect(done?.text).toBe("sable: ");
    expect(done?.caret).toBe(7);
  });

  it("appends only a space mid-line", () => {
    const done = startCompletion("ask sab", 7, NICKS);
    expect(done?.text).toBe("ask sable ");
  });

  it("uses the candidate's own casing", () => {
    expect(startCompletion("PHR", 3, NICKS)?.text).toBe("phrack: ");
  });

  it("keeps text after the caret", () => {
    const done = startCompletion("hey sab there", 7, NICKS);
    expect(done?.text).toBe("hey sable  there");
  });

  it("returns null when nothing matches, so Tab can fall through", () => {
    expect(startCompletion("zzz", 3, NICKS)).toBe(null);
    expect(startCompletion("", 0, NICKS)).toBe(null);
    expect(startCompletion("sab ", 4, NICKS)).toBe(null);
  });

  it("starts at a new line, not at the start of the box", () => {
    const done = startCompletion("first\nsab", 9, NICKS);
    expect(done?.text).toBe("first\nsable: ");
  });
});

describe("cycleCompletion", () => {
  it("walks the candidates and wraps", () => {
    const first = startCompletion("sab", 3, NICKS)!;
    expect(first.text).toBe("sable: ");

    const second = cycleCompletion(first);
    expect(second.text).toBe("sableton: ");
    expect(second.caret).toBe(10);

    const third = cycleCompletion(second);
    expect(third.text).toBe("sable: ");
  });

  it("keeps the surrounding text intact while cycling", () => {
    let state = startCompletion("hey sab you", 7, NICKS)!;
    expect(state.text).toBe("hey sable  you");
    state = cycleCompletion(state);
    expect(state.text).toBe("hey sableton  you");
  });
});

describe("matchCommands", () => {
  it("hints while a bare command is being typed", () => {
    expect(matchCommands("/")?.length).toBeGreaterThan(5);
    expect(matchCommands("/jo")?.map((c) => c.name)).toEqual(["join"]);
    expect(matchCommands("/m")?.map((c) => c.name)).toEqual(["msg", "me", "mode"]);
  });

  it("stops once the command takes an argument", () => {
    expect(matchCommands("/join #ctf-ops")).toBe(null);
  });

  it("stays quiet for ordinary text and for an unknown command", () => {
    expect(matchCommands("hello")).toBe(null);
    expect(matchCommands("/zzzz")).toBe(null);
  });
});
