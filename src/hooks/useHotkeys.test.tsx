import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Binding } from "@/lib/keybindings";
import { useAppStore } from "@/store";
import { targetKey, type TargetKey } from "@/store/keys";
import { activeTarget, oneView } from "@/components/shell/fixtures";
import type { Channel, Network, Query } from "@/types";
import { useAppHotkeys, useHotkeys, type HotkeyHandlers } from "./useHotkeys";

function Host({ handlers, bindings }: { handlers: HotkeyHandlers; bindings?: Binding[] }) {
  useHotkeys(handlers, bindings);
  return (
    <div>
      <input aria-label="composer" />
      <button type="button">send</button>
    </div>
  );
}

function press(from: Element | Document, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  from.dispatchEvent(event);
  return event;
}

const CTRL_K = { key: "k", code: "KeyK", ctrlKey: true };
const CTRL_1 = { key: "1", code: "Digit1", ctrlKey: true };

describe("useHotkeys", () => {
  it("runs the action bound to a chord", () => {
    const palette = vi.fn();
    render(<Host handlers={{ "palette.toggle": palette }} />);

    const event = press(document, CTRL_K);

    expect(palette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("passes the binding's argument", () => {
    const jump = vi.fn();
    render(<Host handlers={{ "target.jump": jump }} />);

    press(document, { key: "3", code: "Digit3", ctrlKey: true });

    expect(jump).toHaveBeenCalledWith(3);
  });

  it("ignores an unbound chord", () => {
    const palette = vi.fn();
    render(<Host handlers={{ "palette.toggle": palette }} />);

    const event = press(document, { key: "j", code: "KeyJ", ctrlKey: true });

    expect(palette).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not fire a plain chord while a text input has focus", () => {
    const jump = vi.fn();
    const { getByLabelText } = render(<Host handlers={{ "target.jump": jump }} />);

    const event = press(getByLabelText("composer"), CTRL_1);

    expect(jump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("fires a chord that opts in while a text input has focus", () => {
    const palette = vi.fn();
    const { getByLabelText } = render(<Host handlers={{ "palette.toggle": palette }} />);

    press(getByLabelText("composer"), CTRL_K);

    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("still fires a plain chord outside a text input", () => {
    const jump = vi.fn();
    const { getByText } = render(<Host handlers={{ "target.jump": jump }} />);

    press(getByText("send"), CTRL_1);

    expect(jump).toHaveBeenCalledTimes(1);
  });

  it("leaves the event alone when the handler declines", () => {
    const dismiss = vi.fn(() => false);
    render(<Host handlers={{ "overlay.dismiss": dismiss }} />);

    const event = press(document, { key: "Escape" });

    expect(dismiss).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("takes a replacement table without touching the dispatcher", () => {
    const palette = vi.fn();
    const bindings: Binding[] = [
      { chord: "Mod+Shift+P", action: "palette.toggle", description: "Command palette" },
    ];
    render(<Host handlers={{ "palette.toggle": palette }} bindings={bindings} />);

    press(document, CTRL_K);
    expect(palette).not.toHaveBeenCalled();

    press(document, { key: "p", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const palette = vi.fn();
    render(<Host handlers={{ "palette.toggle": palette }} />).unmount();

    press(document, CTRL_K);

    expect(palette).not.toHaveBeenCalled();
  });
});

const network: Network = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  status: { state: "connected" },
  currentNick: "sable",
  sasl: { state: "notConfigured" },
  capsEnabled: [],
  lagMs: null,
};

function channel(name: string, unread = 0): Channel {
  return {
    network: "libera",
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 2,
    unread,
    highlights: 0,
    muted: false,
  };
}

function query(nick: string): Query {
  return { network: "libera", nick, account: null, unread: 0, online: true, muted: false };
}

/** #ctf-ops, #hackint, #linux, then the query `phrack`. */
function seedStore() {
  useAppStore.setState({
    networks: { libera: network },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", "#ctf-ops")]: channel("#ctf-ops"),
      [targetKey("libera", "#hackint")]: channel("#hackint", 12),
      [targetKey("libera", "#linux")]: channel("#linux"),
    },
    queries: { [targetKey("libera", "phrack")]: query("phrack") },
    ...oneView(null),
    recent: [],
    rosterHidden: {},
    paletteOpen: false,
    searchOpen: false,
  });
}

function AppHost() {
  useAppHotkeys();
  return <input aria-label="composer" />;
}

function activeKey(): TargetKey | null {
  const active = activeTarget();
  return active ? targetKey(active.network, active.target) : null;
}

describe("useAppHotkeys", () => {
  beforeEach(seedStore);

  it("jumps to the nth target with Ctrl+1..9", () => {
    render(<AppHost />);

    press(document, CTRL_1);
    expect(activeKey()).toBe(targetKey("libera", "#ctf-ops"));

    press(document, { key: "4", code: "Digit4", ctrlKey: true });
    expect(activeKey()).toBe(targetKey("libera", "phrack"));
  });

  it("walks targets with Alt+Up and Alt+Down", () => {
    render(<AppHost />);
    useAppStore.getState().setActive({ network: "libera", target: "#hackint" });

    press(document, { key: "ArrowDown", altKey: true });
    expect(activeKey()).toBe(targetKey("libera", "#linux"));

    press(document, { key: "ArrowUp", altKey: true });
    expect(activeKey()).toBe(targetKey("libera", "#hackint"));
  });

  /** Where the sidebar's rule stops. A chord that steps through the target list
   * moves the pane you are in; throwing focus to whichever pane already held
   * that target would make the list unwalkable. */
  it("jumps the focused pane even onto a target another pane is showing", () => {
    render(<AppHost />);
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    store.splitActiveView("row");
    store.setActive({ network: "libera", target: "#hackint" });
    const [first, second] = useAppStore.getState().viewOrder;
    expect(useAppStore.getState().activeViewId).toBe(second);

    // Ctrl+1 is #ctf-ops, which the first pane is already on.
    press(document, CTRL_1);

    expect(useAppStore.getState().activeViewId).toBe(second);
    expect(useAppStore.getState().views[first!]!.target).toBe("#ctf-ops");
    expect(useAppStore.getState().views[second!]!.target).toBe("#ctf-ops");
  });

  it("skips read targets with Alt+Shift+Down", () => {
    render(<AppHost />);
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });

    press(document, { key: "ArrowDown", altKey: true, shiftKey: true });

    expect(activeKey()).toBe(targetKey("libera", "#hackint"));
  });

  it("walks visit history with Alt+Left and Alt+Right", () => {
    render(<AppHost />);
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    store.setActive({ network: "libera", target: "#linux" });
    store.setActive({ network: "libera", target: "phrack" });

    press(document, { key: "ArrowLeft", altKey: true });
    expect(activeKey()).toBe(targetKey("libera", "#linux"));

    press(document, { key: "ArrowLeft", altKey: true });
    expect(activeKey()).toBe(targetKey("libera", "#ctf-ops"));

    press(document, { key: "ArrowRight", altKey: true });
    expect(activeKey()).toBe(targetKey("libera", "#linux"));
  });

  it("does not move past the ends of the history", () => {
    render(<AppHost />);
    useAppStore.getState().setActive({ network: "libera", target: "#linux" });

    press(document, { key: "ArrowLeft", altKey: true });
    press(document, { key: "ArrowLeft", altKey: true });

    expect(activeKey()).toBe(targetKey("libera", "#linux"));
  });

  it("toggles the palette, and the focused pane's member list", () => {
    // The roster belongs to a pane, so the chord needs one to act on.
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#linux" }));
    render(<AppHost />);
    const focused = useAppStore.getState().activeViewId!;

    press(document, CTRL_K);
    expect(useAppStore.getState().paletteOpen).toBe(true);

    press(document, { key: "m", code: "KeyM", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().rosterHidden[focused]).toBe(true);
  });

  /* Reached while reading a channel that has gone busy, which is when the
     composer holds the caret. A chord that only worked with the timeline
     focused would not be reachable at the moment it is wanted. */
  it("puts the nickname on every line with Ctrl+Shift+N, and takes it off again", () => {
    const { getByLabelText } = render(<AppHost />);

    press(getByLabelText("composer"), { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().presentation.nickEveryLine).toBe(true);
    expect(localStorage.getItem("ircx.presentation")).toContain('"nickEveryLine":true');

    press(document, { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().presentation.nickEveryLine).toBe(false);
  });

  it("opens search with Ctrl+F even from the composer", () => {
    const { getByLabelText } = render(<AppHost />);

    press(getByLabelText("composer"), { key: "f", code: "KeyF", ctrlKey: true });

    expect(useAppStore.getState().searchOpen).toBe(true);
  });

  it("does not jump by number while the composer has focus", () => {
    const { getByLabelText } = render(<AppHost />);

    press(getByLabelText("composer"), CTRL_1);

    expect(activeKey()).toBeNull();
  });

  it("leaves Alt+Left to the caret while the composer has focus", () => {
    const { getByLabelText } = render(<AppHost />);
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    store.setActive({ network: "libera", target: "#linux" });

    const event = press(getByLabelText("composer"), { key: "ArrowLeft", altKey: true });

    expect(activeKey()).toBe(targetKey("libera", "#linux"));
    expect(event.defaultPrevented).toBe(false);
  });

  it("still walks targets with Alt+Down while the composer has focus", () => {
    const { getByLabelText } = render(<AppHost />);
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });

    press(getByLabelText("composer"), { key: "ArrowDown", altKey: true });

    expect(activeKey()).toBe(targetKey("libera", "#hackint"));
  });

  it("closes the palette, then search, then declines Escape", () => {
    render(<AppHost />);
    const store = useAppStore.getState();
    store.togglePalette(true);
    store.toggleSearch(true);

    press(document, { key: "Escape" });
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(useAppStore.getState().searchOpen).toBe(true);

    press(document, { key: "Escape" });
    expect(useAppStore.getState().searchOpen).toBe(false);

    const event = press(document, { key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
  });
});
