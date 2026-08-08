import { beforeEach, describe, expect, it } from "vitest";
import {
  loadFavorites,
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
});
