import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import {
  applyDensity,
  applyOverrides,
  applyTheme,
  catalogue,
  DEFAULT_DENSITY,
} from "@/lib/theme";
import { useAppStore } from "@/store";
import type { AppState } from "@/store/types";
import { AppearanceSheet } from "../AppearanceSheet";

/* `selectTheme` lives in src/lib/theme/session.ts, which reaches the backend to
 * watch the themes directory. Nothing here calls that, but importing the barrel
 * pulls the module in. */
vi.mock("@/lib/ipc", () => ({ ipc: {}, onThemesChanged: vi.fn() }));

const THEMES = catalogue().themes;

const root = document.documentElement;

beforeEach(() => {
  resetStore();
  useAppStore.setState({ appearanceOpen: true, themes: THEMES });
});

/* The theme, the edits and the density are module state in
 * src/lib/theme/apply.ts and one inline declaration on the root element, so a
 * test that leaves any of the three set hands it to the next one. */
afterEach(() => {
  applyTheme(null);
  applyOverrides({});
  applyDensity(DEFAULT_DENSITY);
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  localStorage.clear();
});

function open(patch: Partial<AppState> = {}) {
  useAppStore.setState(patch);
  return render(<AppearanceSheet />);
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function field(token: string): HTMLInputElement {
  return screen.getByLabelText(token) as HTMLInputElement;
}

/** Opening the editor is also choosing the theme, so every test below that
 * types a value is editing the theme the window is actually painting. */
function editLight() {
  fireEvent.click(button("Edit the colours of ircx Light"));
}

function token(name: string): string {
  return root.style.getPropertyValue(name);
}

describe("AppearanceSheet", () => {
  it("stays out of the way until something opens it", () => {
    useAppStore.setState({ appearanceOpen: false });
    const { container } = render(<AppearanceSheet />);

    expect(container.firstChild).toBeNull();
  });

  /** Firing Escape at the dialog element proves nothing on its own: React
   * listens at the root, so the handler only runs for a keystroke that starts
   * inside. Nothing in the sheet takes focus by itself, so this asserts the
   * sheet takes it — otherwise Escape goes wherever focus was left and the only
   * way out is the mouse. */
  it("takes focus, so Escape reaches it and closes it", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(useAppStore.getState().appearanceOpen).toBe(false);
  });

  it("names every theme by author and appearance, and says which is in use", () => {
    open({ themeId: "ircx-dark" });

    expect(screen.getByText("ircx Dark")).toBeTruthy();
    expect(screen.getByText("dark · ircx · 1.0.0 · in use")).toBeTruthy();
    expect(screen.getByText("ircx Light")).toBeTruthy();
    expect(screen.getByText("light · ircx · 1.0.0")).toBeTruthy();
  });

  /** #312. The sentence under the name is the only place it was said, so a
   * screen reader heard two ordinary buttons and no choice between them. */
  it("marks the theme in use as pressed, and the other as not", () => {
    open({ themeId: "ircx-dark" });

    // Anchored: each theme's own button and its "Edit the colours of …" sibling
    // both carry the name.
    expect(button(/^ircx Dark/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/^ircx Light/).getAttribute("aria-pressed")).toBe("false");
  });

  it("paints the theme that was chosen", () => {
    open({ themeId: "ircx-dark" });
    fireEvent.click(screen.getByText("light · ircx · 1.0.0"));

    expect(token("--surface-base")).toBe("#ffffff");
    expect(root.dataset.theme).toBe("ircx-light");
    expect(useAppStore.getState().themeId).toBe("ircx-light");
  });

  /**
   * The reason this screen is worth a sheet of its own. A theme that would not
   * load used to reach the person holding the file as a console warning and a
   * single line in the palette with every sentence but the first cut off; each
   * problem names the field that is wrong and what belongs in it, so each one
   * has to be readable whole.
   */
  it("lists a broken theme's problems in full, every sentence of them", () => {
    open({
      brokenThemes: [
        {
          id: "nord-ish",
          problems: [
            'theme.json needs "author": who to credit, or who to ask about it.',
            "theme.css leaves one property undefined: --scrim. Give each one a value; copying it from src/styles/themes/ircx-dark/theme.css and changing it is the usual way.",
          ],
        },
      ],
    });

    expect(screen.getByText("nord-ish")).toBeTruthy();
    expect(
      screen.getByText(
        'theme.json needs "author": who to credit, or who to ask about it.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/theme\.css leaves one property undefined: --scrim\./),
    ).toBeTruthy();
  });

  describe("density", () => {
    it("offers the three and no others", () => {
      open();

      expect(screen.getByText("For operators and log reading")).toBeTruthy();
      expect(screen.getByText("For being in the conversation")).toBeTruthy();
      expect(screen.getByText("For nine hours of backlog")).toBeTruthy();
    });

    it("repaints the timeline on the one that was chosen", () => {
      open();
      fireEvent.click(button(/Compact/));

      expect(token("--timeline-block-gap")).toBe("6px");
      expect(useAppStore.getState().density).toBe("compact");
    });

    it("marks the density in use as pressed, and moves the mark when it changes", () => {
      open();
      expect(button(/Comfortable/).getAttribute("aria-pressed")).toBe("true");
      expect(button(/Compact/).getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(button(/Compact/));

      expect(button(/Compact/).getAttribute("aria-pressed")).toBe("true");
      expect(button(/Comfortable/).getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("editing a token", () => {
    it("paints the value and keeps it across a re-render", () => {
      const { rerender } = open({ themeId: "ircx-dark" });
      editLight();
      fireEvent.change(field("--accent"), { target: { value: "#2c8a6d" } });

      expect(token("--accent")).toBe("#2c8a6d");

      rerender(<AppearanceSheet />);
      expect(field("--accent").value).toBe("#2c8a6d");
      expect(token("--accent")).toBe("#2c8a6d");
    });

    it("gives the token back to the theme's author on reset", () => {
      open({ themeId: "ircx-dark" });
      editLight();
      fireEvent.change(field("--accent"), { target: { value: "#2c8a6d" } });

      fireEvent.click(button("Reset --accent"));

      expect(token("--accent")).toBe("#0969da");
      expect(field("--accent").value).toBe("#0969da");
      expect(useAppStore.getState().overrides["ircx-light"]).toEqual({});
    });

    /* `--mention-bg` is consumed as a background, so a `url()` in it fetches a
     * remote file the moment a mention is drawn — the one security property the
     * theme system claims. The value is refused rather than warned about
     * because it is not a matter of taste. */
    it("refuses a value that would fetch, and does not paint it", () => {
      open({ themeId: "ircx-dark" });
      editLight();
      fireEvent.change(field("--mention-bg"), {
        target: { value: "url(https://tracker.example/pixel.png)" },
      });

      expect(screen.getByRole("alert").textContent).toBe(
        "--mention-bg uses url(). A theme sets colours, not resources: ircx never fetches a remote file on its own. Use a colour value.",
      );
      expect(token("--mention-bg")).toBe("#0969da14");
      expect(useAppStore.getState().overrides["ircx-light"]).toBeUndefined();
    });

    /* A value copied out of a stylesheet brings the semicolon with it, and a
     * custom property cannot hold one: `setProperty` would do nothing at all,
     * leaving `--surface-base` unset and showing through to the dark theme
     * global.css imports statically. jsdom stores such a value verbatim, so
     * what is asserted here is the refusal rather than the paint. */
    it("refuses a value carrying the semicolon it was copied with", () => {
      open({ themeId: "ircx-dark" });
      editLight();
      fireEvent.change(field("--surface-base"), { target: { value: "#0969da;" } });

      expect(screen.getByRole("alert").textContent).toContain("--surface-base has a ;");
      expect(useAppStore.getState().overrides["ircx-light"]).toBeUndefined();
    });

    /* An edit made here is one person's palette on one machine, and the client
     * is not the arbiter of what they can read: the sentence appears beside a
     * value that applied. */
    it("warns about a nick that fails contrast without withholding it", () => {
      open({ themeId: "ircx-dark" });
      editLight();
      fireEvent.change(field("--nick-1"), { target: { value: "#7fd4e0" } });

      expect(
        screen.getByText(
          /Reads at .+ on --surface-base\. A nickname is body text and wants 4\.5:1\./,
        ),
      ).toBeTruthy();
      expect(token("--nick-1")).toBe("#7fd4e0");
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
