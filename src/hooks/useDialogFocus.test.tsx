import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

/**
 * What jsdom can and cannot answer about #399.
 *
 * It implements no sequential focus navigation: a `keydown` of `Tab` moves
 * nothing, so nothing here can show the browser leaving a dialog, and nothing
 * here would have caught the defect. What it can show is what the hook decides
 * — which stop it turns focus around at, and where it puts focus back — with
 * the keystroke the browser would have acted on dispatched by hand.
 */
function Dialog({ stops = 2 }: { stops?: number }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="A dialog" tabIndex={-1}>
      {Array.from({ length: stops }, (_, i) => (
        <button key={i} type="button">
          stop {i + 1}
        </button>
      ))}
    </div>
  );
}

function tab(from: Element, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  from.dispatchEvent(event);
  return event;
}

/** The cleanup defers its restore by a microtask, so a close is only finished
 * once that has run. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useDialogFocus", () => {
  it("takes focus, so a dialog with nothing of its own to focus can hear Escape", () => {
    const { getByRole } = render(<Dialog />);

    expect(document.activeElement).toBe(getByRole("dialog"));
  });

  it("leaves focus alone when the dialog has already placed it", () => {
    function WithField() {
      const dialog = useRef<HTMLDivElement>(null);
      useDialogFocus(dialog);
      return (
        <div ref={dialog} role="dialog" aria-modal="true" aria-label="A dialog" tabIndex={-1}>
          <input autoFocus aria-label="query" />
        </div>
      );
    }
    const { getByLabelText } = render(<WithField />);

    expect(document.activeElement).toBe(getByLabelText("query"));
  });

  it("turns Tab around at the last stop rather than letting it out", () => {
    const { getAllByRole } = render(<Dialog stops={3} />);
    const buttons = getAllByRole("button");
    const last = buttons[buttons.length - 1]!;
    last.focus();

    const event = tab(last);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("turns Shift+Tab around at the first stop, and at the container", () => {
    const { getAllByRole, getByRole } = render(<Dialog stops={3} />);
    const buttons = getAllByRole("button");
    const last = buttons[buttons.length - 1]!;

    buttons[0]!.focus();
    expect(tab(buttons[0]!, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    getByRole("dialog").focus();
    expect(tab(getByRole("dialog"), true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("leaves the stops in between to the browser", () => {
    const { getAllByRole } = render(<Dialog stops={3} />);
    const middle = getAllByRole("button")[1]!;
    middle.focus();

    const event = tab(middle);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  /** A dialog that has nothing to land on would otherwise hand the page behind
   * it the next Tab. */
  it("holds focus in a dialog with no stops at all", () => {
    const { getByRole } = render(<Dialog stops={0} />);

    const event = tab(getByRole("dialog"));

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(getByRole("dialog"));
  });

  it("gives focus back to what opened it", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(<Dialog />);
    expect(document.activeElement).not.toBe(opener);

    unmount();
    await settle();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("says nothing about focus when what opened it has gone", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(<Dialog />);
    opener.remove();
    unmount();
    await settle();

    expect(document.activeElement).toBe(document.body);
  });

  /** The everyday path in this client: Ctrl+K, then a sheet. The palette is
   * unmounted by the time the sheet closes, so its query field is no use as
   * somewhere to go back to. */
  it("inherits the opener of a dialog it was opened from", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const palette = render(<Dialog />);
    const sheet = render(<Dialog />);
    palette.unmount();
    await settle();

    // The palette handed over rather than closed, so nothing moved yet.
    expect(document.activeElement).not.toBe(opener);

    sheet.unmount();
    await settle();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
