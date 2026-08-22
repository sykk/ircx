import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Plugin fixtures are deliberately malformed guest code — an empty infinite
  // loop and a call to a host global that only exists inside the sandbox. They
  // are inputs to a Rust test, not application source.
  // `.agents` for `.claude`'s reason and not a second one: both hold the same
  // agent tooling — every script of `run-ircx` is byte-identical across them —
  // and neither is application source. Node scripts linted against the browser
  // globals this config is set up for report `process` and `setTimeout` as
  // undefined, 83 times, which is a lint nobody can act on.
  { ignores: ["dist", "target", ".claude", ".agents", "src/types/generated", "crates/**"] },
  // Example plugins are guest code too, but they are meant to be read and
  // copied, so they are linted rather than ignored. `ircx` is the host global
  // the sandbox installs; everything else about them should hold.
  {
    files: ["examples/plugins/**/*.js"],
    languageOptions: { globals: { ircx: "readonly" } },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
