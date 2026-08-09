import type { ThemeSource } from "@/types";
import { BUILT_IN_SOURCES, FALLBACK_THEME_ID, REQUIRED_TOKENS, catalogue, loadTheme } from "./load";
import { parseManifest, parseStylesheet } from "./parse";

const MANIFEST = JSON.stringify({
  name: "Nord",
  author: "someone",
  version: "1.0.0",
  appearance: "dark",
});

/** A theme that only differs from the dark one where the test cares. */
function complete(overrides: Partial<ThemeSource> = {}): ThemeSource {
  const tokens = REQUIRED_TOKENS.map((token) => `${token}: #123456;`).join("\n");
  return {
    id: "nord",
    manifest: MANIFEST,
    stylesheet: `:root {\n${tokens}\n}`,
    uiStylesheet: "",
    ...overrides,
  };
}

describe("the built-in themes", () => {
  it.each(BUILT_IN_SOURCES.map((source) => [source.id, source] as const))(
    "%s loads through the same path as an installed theme",
    (_id, source) => {
      const load = loadTheme(source);
      expect(load.ok ? null : load.problems).toBeNull();
    },
  );

  it("agree on which properties exist", () => {
    // The fallback theme is what REQUIRED_TOKENS is derived from, so comparing
    // it would compare an expression to itself; only the others can disagree.
    for (const source of BUILT_IN_SOURCES.filter((held) => held.id !== FALLBACK_THEME_ID)) {
      const { tokens } = parseStylesheet(source.stylesheet);
      expect(Object.keys(tokens).sort()).toEqual([...REQUIRED_TOKENS]);
    }
  });
});

describe("loadTheme", () => {
  it("accepts a complete theme", () => {
    const load = loadTheme(complete());
    expect(load.ok && load.theme.manifest.name).toBe("Nord");
  });

  it("names every property the stylesheet left out", () => {
    const load = loadTheme(complete({ stylesheet: ":root { --surface-base: #000000; }" }));

    expect(load.ok).toBe(false);
    const [problem] = load.ok ? [] : load.problems;
    expect(problem).toContain("--text-primary");
    expect(problem).toContain("--nick-1");
    expect(problem).not.toContain("--surface-base");
  });

  it("says which one when only one is missing", () => {
    const stylesheet = REQUIRED_TOKENS.filter((token) => token !== "--scrim")
      .map((token) => `${token}: #123456;`)
      .join("\n");
    const load = loadTheme(complete({ stylesheet }));

    expect(load.ok ? [] : load.problems).toEqual([
      expect.stringContaining("one property undefined: --scrim"),
    ]);
  });

  it("reports a missing file rather than a missing property for each one", () => {
    const load = loadTheme(complete({ manifest: "" }));
    expect(load.ok ? [] : load.problems).toEqual([expect.stringContaining("no theme.json")]);
  });

  it("refuses a token that would fetch something", () => {
    const load = loadTheme(
      complete({ stylesheet: `${complete().stylesheet}\n:root { --surface-base: url(http://x/y); }` }),
    );
    expect(load.ok ? [] : load.problems).toEqual([expect.stringContaining("--surface-base uses url()")]);
  });

  it("collects a manifest problem and a stylesheet problem together", () => {
    const load = loadTheme(
      complete({ manifest: JSON.stringify({ name: "Nord", version: "1", appearance: "grey" }) }),
    );

    const problems = load.ok ? [] : load.problems;
    expect(problems).toEqual([
      expect.stringContaining('"author"'),
      expect.stringContaining('"version": "1"'),
      expect.stringContaining('"appearance": "grey"'),
    ]);
  });

  it("refuses ui.css that would fetch something", () => {
    const load = loadTheme(complete({ uiStylesheet: "@import url(x.css);" }));
    expect(load.ok ? [] : load.problems).toEqual([expect.stringContaining("ui.css uses @import")]);
  });

  it("keeps ui.css on a loaded theme", () => {
    const css = "[data-ui='timeline'] { opacity: 1; }";
    const load = loadTheme(complete({ uiStylesheet: css }));
    expect(load.ok && load.theme.uiStylesheet).toBe(css);
  });
});

describe("the cyberpunk example theme", () => {
  it("loads with its ui.css", async () => {
    const [{ readFileSync }, { join }] = await Promise.all([
      import("node:fs"),
      import("node:path"),
    ]);
    const root = join(import.meta.dirname, "../../../examples/themes/cyberpunk");
    const source: ThemeSource = {
      id: "cyberpunk",
      manifest: readFileSync(join(root, "theme.json"), "utf8"),
      stylesheet: readFileSync(join(root, "theme.css"), "utf8"),
      uiStylesheet: readFileSync(join(root, "ui.css"), "utf8"),
    };
    const load = loadTheme(source);
    expect(load.ok && load.theme.uiStylesheet).toContain("@keyframes");
  });
});

describe("catalogue", () => {
  it("is the built-ins when nothing is installed", () => {
    expect(catalogue().themes.map((theme) => theme.id)).toEqual([
      "ircx-dark",
      "ircx-light",
      "ircx-glass",
      "ircx-classic",
    ]);
    expect(catalogue().broken).toEqual([]);
  });

  it("keeps a broken theme listed with its reasons", () => {
    const { themes, broken } = catalogue([complete({ manifest: "{" })]);

    expect(themes.map((theme) => theme.id)).toEqual([
      "ircx-dark",
      "ircx-light",
      "ircx-glass",
      "ircx-classic",
    ]);
    expect(broken).toEqual([{ id: "nord", problems: [expect.stringContaining("not valid JSON")] }]);
  });

  it("will not let an installed theme take a built-in's name", () => {
    const { themes, broken } = catalogue([complete({ id: "ircx-light" })]);

    expect(themes.filter((theme) => theme.id === "ircx-light")).toHaveLength(1);
    expect(broken).toEqual([
      { id: "ircx-light", problems: [expect.stringContaining("Rename the directory")] },
    ]);
  });
});

describe("parseStylesheet", () => {
  it("ignores selectors, so a theme cannot restyle a component", () => {
    const { tokens } = parseStylesheet(
      ".timeline .message { display: none; --surface-base: #010203; }",
    );
    expect(tokens).toEqual({ "--surface-base": "#010203" });
  });

  it("ignores a property inside a comment", () => {
    const { tokens } = parseStylesheet(":root { /* --accent: #ff0000; */ --accent: #00ff00; }");
    expect(tokens).toEqual({ "--accent": "#00ff00" });
  });

  it("takes the last value when one is declared twice", () => {
    const { tokens } = parseStylesheet(":root { --accent: #111111; --accent: #222222; }");
    expect(tokens["--accent"]).toBe("#222222");
  });

  it("keeps a value that spans functions and spaces", () => {
    const { tokens } = parseStylesheet(":root { --scrim: rgb(2 4 8 / 0.66) }");
    expect(tokens["--scrim"]).toBe("rgb(2 4 8 / 0.66)");
  });
});

describe("parseManifest", () => {
  it("reads a complete manifest", () => {
    expect(parseManifest(MANIFEST).manifest).toEqual({
      name: "Nord",
      author: "someone",
      version: "1.0.0",
      appearance: "dark",
    });
  });

  it("rejects a JSON array", () => {
    expect(parseManifest("[]").problems).toEqual(["theme.json must hold a JSON object."]);
  });

  it("names the field when appearance is missing", () => {
    const { problems } = parseManifest(
      JSON.stringify({ name: "n", author: "a", version: "1.0.0" }),
    );
    expect(problems).toEqual([expect.stringContaining('needs "appearance"')]);
  });
});
