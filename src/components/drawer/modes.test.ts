import { describe, expect, it } from "vitest";
import { describeModes } from "./modes";

describe("describeModes", () => {
  it("spells out the pair almost every channel carries", () => {
    expect(describeModes("+nt")).toEqual([
      "no external messages",
      "topic locked by ops",
    ]);
  });

  it("hands each argument to the mode that takes one", () => {
    expect(describeModes("+ntkl hunter2 50")).toEqual([
      "no external messages",
      "topic locked by ops",
      "key required hunter2",
      "limit 50",
    ]);
  });

  it("keeps a mode whose argument the server did not send", () => {
    expect(describeModes("+l")).toEqual(["limit"]);
  });

  it("passes an unknown letter through rather than dropping it", () => {
    expect(describeModes("+nY")).toEqual(["no external messages", "+Y"]);
  });

  it("distinguishes letters that differ only in case", () => {
    expect(describeModes("+rR")).toEqual(["registered channel", "registered users only"]);
  });

  it("returns nothing for a channel with no modes", () => {
    expect(describeModes("")).toEqual([]);
    expect(describeModes("+")).toEqual([]);
  });
});
