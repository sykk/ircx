import { describe, expect, it } from "vitest";
import { allEmojis, searchEmojis } from "./emojiCatalog";

describe("emojiCatalog", () => {
  it("ships the full Emoji Mart set", () => {
    expect(allEmojis().length).toBeGreaterThan(1800);
  });

  it("finds emoji by name", () => {
    const hits = searchEmojis("eggplant");
    expect(hits.some((entry) => entry.native === "🍆")).toBe(true);
  });

  it("finds emoji by keyword", () => {
    const hits = searchEmojis("droplets");
    expect(hits.some((entry) => entry.native === "💦")).toBe(true);
  });
});
