import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CTF_OPS, CTF_OPS_MEMBERS, LIBERA } from "@/components/drawer/fixtures";
import { makeConversation } from "@/components/timeline/fixtures";
import { ESTIMATED_ROW_PX } from "@/components/timeline/Timeline";
import { useAppHotkeys } from "@/hooks/useHotkeys";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { PaneTree } from "./PaneTree";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getDraft: vi.fn(),
    setDraft: vi.fn(),
    setTyping: vi.fn(),
    loadHistory: vi.fn(),
    submitInput: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn() }));

const CTF = targetKey("libera", "#ctf-ops");
const HACKINT = targetKey("libera", "#hackint");

beforeAll(() => {
  // jsdom lays nothing out, so the virtualiser sees a zero-high viewport and
  // renders no rows. Rows measure at exactly the estimate, and a scroller's
  // height is whatever the virtualiser wrote on its sizer.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? ESTIMATED_ROW_PX : 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const sizer = this.firstElementChild as HTMLElement | null;
      const declared = sizer?.style.height;
      return declared ? Number.parseFloat(declared) : this.offsetHeight;
    },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.getDraft.mockResolvedValue(null);
  ipcMock.setDraft.mockResolvedValue(undefined);
  ipcMock.setTyping.mockResolvedValue(undefined);
  ipcMock.loadHistory.mockResolvedValue([]);

  const messages = makeConversation({ count: 300, seed: 4 });
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    channels: {
      [CTF]: CTF_OPS,
      [HACKINT]: { ...CTF_OPS, name: "#hackint" },
    },
    members: { [CTF]: CTF_OPS_MEMBERS },
    timelines: {
      [CTF]: { messages, unreadFrom: null, hasMore: true, loadingOlder: false },
      [HACKINT]: { messages, unreadFrom: null, hasMore: true, loadingOlder: false },
    },
    views: {},
    viewOrder: [],
    activeViewId: null,
    layout: null,
    rosterHidden: {},
  });
  useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });
});

/** Splits the one open pane and returns the two view ids in pane order. */
function split(direction: "row" | "column"): [string, string] {
  act(() => useAppStore.getState().splitActiveView(direction));
  const [first, second] = useAppStore.getState().viewOrder;
  return [first!, second!];
}

function panes(): HTMLElement[] {
  return screen.getAllByRole("region");
}

/** Lets each composer's draft lookup resolve, which it does on mount. */
async function settle() {
  await act(async () => {});
}

describe("PaneTree", () => {
  it("renders one pane, and one more for each split", async () => {
    const { rerender } = render(<PaneTree />);
    await settle();
    expect(panes()).toHaveLength(1);

    split("row");
    rerender(<PaneTree />);
    await settle();

    expect(panes()).toHaveLength(2);
    expect(screen.getAllByLabelText("Message #ctf-ops")).toHaveLength(2);
  });

  it("gives two panes on one channel their own scroll positions", async () => {
    const [first, second] = split("row");
    const store = useAppStore.getState();
    act(() => {
      store.setViewScroll(first, 1_200);
      store.setViewScroll(second, 40);
    });

    render(<PaneTree />);
    await settle();
    const scrollers = screen.getAllByTestId("timeline-scroller");

    expect(scrollers[0]!.scrollTop).toBe(1_200);
    expect(scrollers[1]!.scrollTop).toBe(40);
  });

  it("does not move the other pane when one is scrolled", async () => {
    const [first, second] = split("row");
    act(() => useAppStore.getState().setViewScroll(second, 40));
    render(<PaneTree />);
    await settle();
    const scrollers = screen.getAllByTestId("timeline-scroller");

    scrollers[0]!.scrollTop = 900;
    fireEvent.scroll(scrollers[0]!);

    const { views } = useAppStore.getState();
    expect(views[first]!.scrollPosition).toBe(900);
    expect(views[second]!.scrollPosition).toBe(40);
    expect(scrollers[1]!.scrollTop).toBe(40);
  });

  it("marks the focused pane with a rule rather than a border round it", async () => {
    const [first] = split("row");
    render(<PaneTree />);
    await settle();

    fireEvent.pointerDown(screen.getAllByTestId("timeline-scroller")[0]!);

    expect(useAppStore.getState().activeViewId).toBe(first);
    expect(panes()[0]!.className).toContain("border-t");
    expect(panes()[0]!.className).toContain("border-[var(--border-strong)]");
    expect(panes()[1]!.className).toContain("border-transparent");
  });

  it("leaves the focus rule off while there is only one pane", async () => {
    render(<PaneTree />);
    await settle();
    expect(panes()[0]!.className).not.toContain("border-t");
  });

  it("gives every pane on a channel its own member list", async () => {
    split("row");
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#hackint" }));
    render(<PaneTree />);
    await settle();

    // Two channels open side by side means two rosters, each inside its own
    // pane. One shared panel pointed at one of them is the thing this replaced.
    const rosters = screen.getAllByRole("complementary");
    expect(rosters.map((roster) => roster.getAttribute("aria-label")).sort()).toEqual([
      "#ctf-ops members",
      "#hackint members",
    ]);
    for (const roster of rosters) {
      expect(panes().some((pane) => pane.contains(roster))).toBe(true);
    }
  });

  it("draws no member list for a pane that has nobody to list", async () => {
    split("row");
    act(() => useAppStore.getState().openConsole("libera"));
    render(<PaneTree />);
    await settle();

    // No empty column standing in for a roster: the console pane gives the
    // space back to the conversation.
    const rosters = screen.getAllByRole("complementary");
    expect(rosters).toHaveLength(1);
    expect(rosters[0]!.getAttribute("aria-label")).toBe("#ctf-ops members");
  });

  it("hides one pane's member list and leaves the other's alone", async () => {
    const [first] = split("row");
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#hackint" }));
    render(<PaneTree />);
    await settle();

    act(() => useAppStore.getState().toggleRoster(first));
    await settle();

    const rosters = screen.getAllByRole("complementary");
    expect(rosters).toHaveLength(1);
    expect(rosters[0]!.getAttribute("aria-label")).toBe("#hackint members");
  });

  it("does not hand a closed pane's hidden roster to the next pane", async () => {
    const [, second] = split("row");
    render(<PaneTree />);
    await settle();
    act(() => useAppStore.getState().toggleRoster(second));

    act(() => useAppStore.getState().closeView(second));
    await settle();

    expect(useAppStore.getState().rosterHidden[second]).toBeUndefined();
  });
});

function Host() {
  useAppHotkeys();
  return <PaneTree />;
}

function press(init: KeyboardEventInit) {
  fireEvent.keyDown(document, { bubbles: true, cancelable: true, ...init });
}

describe("pane keys", () => {
  it("splits, walks the panes, and closes without a mouse", async () => {
    render(<Host />);
    await settle();

    press({ key: "\\", code: "Backslash", ctrlKey: true });
    await settle();
    expect(panes()).toHaveLength(2);

    const [first, second] = useAppStore.getState().viewOrder;
    expect(useAppStore.getState().activeViewId).toBe(second);

    press({ key: "ArrowUp", altKey: true });
    expect(useAppStore.getState().activeViewId).toBe(first);
    expect(document.activeElement).toBe(
      screen.getAllByLabelText("Message #ctf-ops")[0],
    );

    press({ key: "ArrowDown", altKey: true });
    expect(useAppStore.getState().activeViewId).toBe(second);

    press({ key: "w", code: "KeyW", ctrlKey: true });
    await settle();
    expect(panes()).toHaveLength(1);
    expect(useAppStore.getState().activeViewId).toBe(first);
  });

  it("stacks the panes on the shifted chord", async () => {
    render(<Host />);
    await settle();

    press({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true });
    await settle();

    expect(useAppStore.getState().layout).toMatchObject({ direction: "column" });
  });

  it("keeps the last pane open", async () => {
    render(<Host />);
    await settle();

    press({ key: "w", code: "KeyW", ctrlKey: true });

    expect(panes()).toHaveLength(1);
  });
});

describe("resizing a split", () => {
  /** jsdom lays nothing out, so a divider asking its parent how wide the split
   * is gets zero and refuses to move. This is the only geometry these tests
   * need: one split, 1000 by 800, with its top left at the origin. */
  function measured() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });
  }

  function divider(name = "Pane width"): HTMLElement {
    return screen.getByRole("separator", { name });
  }

  function drag(handle: HTMLElement, to: { clientX?: number; clientY?: number }) {
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, ...to });
    fireEvent.pointerUp(handle, { pointerId: 1 });
  }

  function ratio(): number {
    const layout = useAppStore.getState().layout;
    return layout?.type === "split" ? (layout.ratio ?? 0.5) : NaN;
  }

  /** What the split actually carries, which is nothing until something moves
   * it — distinct from the even half that absence is read as. */
  function written(): number | undefined {
    const layout = useAppStore.getState().layout;
    return layout?.type === "split" ? layout.ratio : undefined;
  }

  it("starts even, and says so", async () => {
    split("row");
    render(<PaneTree />);
    await settle();

    expect(written()).toBeUndefined();
    expect(ratio()).toBe(0.5);
    expect(divider().getAttribute("aria-valuenow")).toBe("50");
    expect(divider().getAttribute("aria-orientation")).toBe("vertical");
  });

  it("follows the pointer, as a share of the split rather than a pixel count", async () => {
    measured();
    split("row");
    render(<PaneTree />);
    await settle();

    drag(divider(), { clientX: 700, clientY: 400 });

    expect(ratio()).toBeCloseTo(0.7);
    expect(divider().getAttribute("aria-valuenow")).toBe("70");
  });

  it("measures a stacked split down the window instead of across it", async () => {
    measured();
    split("column");
    render(<PaneTree />);
    await settle();

    const handle = divider("Pane height");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    drag(handle, { clientX: 500, clientY: 200 });

    // 200 of 800 down, not 500 of 1000 across.
    expect(ratio()).toBeCloseTo(0.25);
  });

  it("leaves both sides a pane rather than a sliver", async () => {
    measured();
    split("row");
    render(<PaneTree />);
    await settle();

    drag(divider(), { clientX: 5, clientY: 400 });

    expect(ratio()).toBeCloseTo(0.15);
  });

  it("moves on the arrow keys, so it is not a pointer-only control", async () => {
    split("row");
    render(<PaneTree />);
    await settle();

    fireEvent.keyDown(divider(), { key: "ArrowRight" });
    expect(ratio()).toBeCloseTo(0.52);

    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    expect(ratio()).toBeCloseTo(0.48);
  });

  it("ignores a pointer that never went down on it", async () => {
    measured();
    split("row");
    render(<PaneTree />);
    await settle();

    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 900, clientY: 400 });

    expect(written()).toBeUndefined();
    expect(divider().getAttribute("aria-valuenow")).toBe("50");
  });

  /** Each divider names its own split by the path to it, so dragging the inner
   * one must not move the outer one and the other way round. */
  it("moves the split its own divider belongs to, and no other", async () => {
    measured();
    const [first] = split("row");
    act(() => useAppStore.getState().focusView(first));
    split("column");
    render(<PaneTree />);
    await settle();

    // The timeline draws its own separators for dates and the unread seam, so
    // this counts the ones that divide panes.
    expect(screen.getAllByRole("separator", { name: /^Pane / })).toHaveLength(2);
    drag(divider("Pane height"), { clientX: 500, clientY: 600 });

    const layout = useAppStore.getState().layout;
    expect(layout?.type === "split" && (layout.ratio ?? 0.5)).toBe(0.5);
    expect(
      layout?.type === "split" &&
        layout.children[0].type === "split" &&
        layout.children[0].ratio,
    ).toBeCloseTo(0.75);
  });
});
