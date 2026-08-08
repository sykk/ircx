import { afterEach, describe, expect, it } from "vitest";
import {
  UI_STYLE_ID,
  applyUiStylesheet,
  clearUiStylesheet,
  uiStylesheetProblem,
} from "./ui-css";

afterEach(() => {
  clearUiStylesheet();
});

describe("uiStylesheetProblem", () => {
  it("accepts an empty file", () => {
    expect(uiStylesheetProblem("")).toBeNull();
    expect(uiStylesheetProblem("  \n  ")).toBeNull();
  });

  it("accepts keyframes and transitions", () => {
    const css = `
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      [data-ui="message-row"] { animation: fade-in 0.2s ease-out; }
    `;
    expect(uiStylesheetProblem(css)).toBeNull();
  });

  it.each([
    ["@import url(x.css)", "@import"],
    ["background: url(http://x/y)", "url()"],
    ["width: expression(alert(1))", "expression()"],
    ["-moz-binding: url(x)", "-moz-binding"],
    ["behavior: url(x.htc)", "behavior"],
    ["background: javascript:alert(1)", "javascript:"],
  ])("refuses %s", (css, fragment) => {
    expect(uiStylesheetProblem(css)).toContain(fragment);
  });
});

describe("applyUiStylesheet", () => {
  it("injects css into the document head", () => {
    applyUiStylesheet("[data-ui='timeline'] { opacity: 0.99; }");
    const node = document.getElementById(UI_STYLE_ID);
    expect(node?.textContent).toContain("[data-ui='timeline']");
  });

  it("clears the node when given nothing", () => {
    applyUiStylesheet("body { color: red; }");
    applyUiStylesheet("");
    expect(document.getElementById(UI_STYLE_ID)?.textContent).toBe("");
  });
});
