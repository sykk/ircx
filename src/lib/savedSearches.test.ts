import { beforeEach, describe, expect, it } from "vitest";
import { loadSavedSearches, removeSavedSearch, saveSearch } from "./savedSearches";

beforeEach(() => localStorage.clear());

describe("saved searches", () => {
  it("keeps the newest search first without duplicates", () => {
    saveSearch(" deploy ");
    saveSearch("incident");
    expect(saveSearch("deploy")).toEqual(["deploy", "incident"]);
    expect(loadSavedSearches()).toEqual(["deploy", "incident"]);
  });

  it("removes a saved search", () => {
    saveSearch("deploy");
    expect(removeSavedSearch("deploy")).toEqual([]);
  });

  it("refuses malformed stored values", () => {
    localStorage.setItem("ircx.search.saved", JSON.stringify(["valid", 4, "", "valid"]));
    expect(loadSavedSearches()).toEqual(["valid"]);
    localStorage.setItem("ircx.search.saved", "{");
    expect(loadSavedSearches()).toEqual([]);
  });

  it("keeps at most twelve searches", () => {
    for (let index = 0; index < 14; index += 1) saveSearch(`query ${index}`);
    expect(loadSavedSearches()).toHaveLength(12);
    expect(loadSavedSearches()[0]).toBe("query 13");
  });
});
