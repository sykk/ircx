import { afterEach, describe, expect, it } from "vitest";
import { rememberInstalled, rememberedInstalled } from "./remembered";

const KEY = "ircx.theme.installed";

const harbour = {
  id: "harbour",
  manifest: JSON.stringify({ name: "Harbour", author: "a walk", version: "1.0.0", appearance: "light" }),
  stylesheet: ":root { --surface-base: #ffffff; }",
  uiStylesheet: "",
};

afterEach(() => localStorage.removeItem(KEY));

describe("the installed theme a window opens on", () => {
  it("comes back as the files it went in as", () => {
    rememberInstalled(harbour);
    expect(rememberedInstalled()).toEqual(harbour);
  });

  it("fills in an empty ui.css when an older record has none", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ id: "harbour", manifest: harbour.manifest, stylesheet: harbour.stylesheet }),
    );
    expect(rememberedInstalled()).toEqual(harbour);
  });

  it("is forgotten when a built-in takes over", () => {
    rememberInstalled(harbour);
    rememberInstalled(null);
    expect(rememberedInstalled()).toBeNull();
  });

  it("is nothing at all on a first launch", () => {
    expect(rememberedInstalled()).toBeNull();
  });

  /* localStorage is a text file anyone can edit, so everything below is what
   * somebody else wrote rather than what this module did. The shape is checked
   * here; whether the files are worth painting is `catalogue`'s question, which
   * is the reason the source is kept rather than the tokens it parses to. */
  it.each([
    ["not JSON at all", "{{{"],
    ["a bare string", '"harbour"'],
    ["null", "null"],
    ["an array", "[]"],
    ["no id", JSON.stringify({ manifest: "{}", stylesheet: "" })],
    ["an empty id", JSON.stringify({ id: "", manifest: "{}", stylesheet: "" })],
    ["a stylesheet that is not a string", JSON.stringify({ id: "x", manifest: "{}", stylesheet: 4 })],
    ["a manifest that is not a string", JSON.stringify({ id: "x", manifest: [], stylesheet: "" })],
  ])("refuses %s", (_what, held) => {
    localStorage.setItem(KEY, held);
    expect(rememberedInstalled()).toBeNull();
  });
});
