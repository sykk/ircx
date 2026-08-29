import { beforeEach, describe, expect, it } from "vitest";
import {
  loadFavorites,
  loadMostUsed,
  loadRecents,
  recordRecent,
  toggleFavorite,
} from "./emojiPrefs";

beforeEach(() => {
  localStorage.clear();
});

describe("emojiPrefs", () => {
  it("keeps recents in click order without duplicates", () => {
    recordRecent("🍆");
    recordRecent("💦");
    recordRecent("🍆");

    expect(loadRecents()).toEqual(["🍆", "💦"]);
  });

  it("toggles favorites", () => {
    toggleFavorite("🔥");
    expect(loadFavorites()).toEqual(["🔥"]);

    toggleFavorite("🔥");
    expect(loadFavorites()).toEqual([]);
  });

  it("ranks emoji by use count and then recency", () => {
    recordRecent("🔥");
    recordRecent("👍");
    recordRecent("😂");
    recordRecent("👍");

    expect(loadMostUsed()).toEqual(["👍", "😂", "🔥"]);
  });
});
