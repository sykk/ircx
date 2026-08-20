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
  // The padding box is the border box here, nothing having a border or a
  // scrollbar. A zero clientHeight reads as a pane that has not been laid out.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.offsetHeight;
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
      [CTF]: { messages, unreadFrom: null, readMarker: null, hasMore: true, loadingOlder: false, askedBehind: null },
      [HACKINT]: { messages, unreadFrom: null, readMarker: null, hasMore: true, loadingOlder: false, askedBehind: null },
    },
    views: {},
    viewOrder: [],
    activeViewId: null,
    layout: null,
    rosterHidden: {},
    rosterWidth: null,
    rawAnchor: {},
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

  it("gives two panes on one channel their own reading positions", async () => {
    const [first, second] = split("row");
    render(<PaneTree />);
    await settle();
    const scrollers = screen.getAllByTestId("timeline-scroller");

    scrollers[0]!.scrollTop = 900;
    fireEvent.scroll(scrollers[0]!);
    scrollers[1]!.scrollTop = 4_000;
    fireEvent.scroll(scrollers[1]!);

    const { viewAnchor } = useAppStore.getState();
    expect(viewAnchor[first]).toBeTruthy();
    expect(viewAnchor[second]).toBeTruthy();
    expect(viewAnchor[first]).not.toBe(viewAnchor[second]);
  });

  it("does not move the other pane when one is scrolled", async () => {
    const [first, second] = split("row");
    render(<PaneTree />);
    await settle();
    const scrollers = screen.getAllByTestId("timeline-scroller");

    scrollers[1]!.scrollTop = 4_000;
    fireEvent.scroll(scrollers[1]!);
    const parked = useAppStore.getState().viewAnchor[second];

    scrollers[0]!.scrollTop = 900;
    fireEvent.scroll(scrollers[0]!);

    const { viewAnchor } = useAppStore.getState();
    expect(viewAnchor[first]).not.toBe(parked);
    expect(viewAnchor[second]).toBe(parked);
    expect(scrollers[1]!.scrollTop).toBe(4_000);
  });

  /** #307. A split rebuilds the pane, so the position only survives if the
   * store carries it — and it used to be overwritten with the top of the
   * channel on the way back. */
  it("brings a pane back to the row it was reading after it is rebuilt", async () => {
    const [first] = split("row");
    const { unmount } = render(<PaneTree />);
    await settle();

    const scroller = screen.getAllByTestId("timeline-scroller")[0]!;
    scroller.scrollTop = 4_000;
    fireEvent.scroll(scroller);
    const parked = useAppStore.getState().viewAnchor[first];
    expect(parked).toBeTruthy();

    unmount();
    // The restore goes through the virtualiser, which scrolls by `scrollTo`, and
    // jsdom has none. Put back after the render that consumes the anchor.
    const withoutScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    } as HTMLElement["scrollTo"];
    try {
      render(<PaneTree />);
      await settle();
    } finally {
      HTMLElement.prototype.scrollTo = withoutScrollTo;
    }

    expect(useAppStore.getState().viewAnchor[first]).toBe(parked);
    expect(screen.getAllByTestId("timeline-scroller")[0]!.scrollTop).toBeGreaterThan(3_000);
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
  /** jsdom lays nothing out, so every figure the divider reads comes from here.
   * The width is a parameter because the pixel floor turns on it: a split too
   * narrow for two floors behaves differently from one that fits them. */
  function measured({ width = 1000 } = {}) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 800,
      width,
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

  /**
   * `MIN_SHARE` is 0.15 and cannot be what stops here: a share does not know
   * the window, and 15% of a real one is 147px of conversation wrapping message
   * text to a character a line. The floor is 280px against this mocked 1000px
   * split, so 0.28. #367.
   */
  it("leaves both sides a pane rather than a sliver", async () => {
    measured();
    split("row");
    render(<PaneTree />);
    await settle();

    drag(divider(), { clientX: 5, clientY: 400 });

    expect(ratio()).toBeCloseTo(0.28);
  });

  it("holds the far side to the same floor", async () => {
    measured();
    split("row");
    render(<PaneTree />);
    await settle();

    drag(divider(), { clientX: 995, clientY: 400 });

    expect(ratio()).toBeCloseTo(0.72);
  });

  /** A split too narrow to give both sides the floor gets an even one, which
   * is the best the space allows. Refusing to move at all would read as a
   * broken divider. */
  it("halves a split too small for two panes rather than sticking", async () => {
    measured({ width: 400 });
    split("row");
    render(<PaneTree />);
    await settle();

    drag(divider(), { clientX: 20, clientY: 400 });

    expect(ratio()).toBeCloseTo(0.5);
  });

  /** The floor is a width, so a stacked split is not its business — a pane
   * above another is short rather than narrow, and that measurement has not
   * been taken. */
  it("does not apply the width floor to a stacked split", async () => {
    measured();
    split("column");
    render(<PaneTree />);
    await settle();

    drag(divider("Pane height"), { clientX: 500, clientY: 40 });

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

/**
 * #315, the other half of #308. A console pane showing the protocol log kept
 * its follow-the-tail flag in a ref and its position in the DOM, so a split
 * anywhere in the window returned a reader who had scrolled back to the live
 * tail.
 */
describe("a pane reading the protocol log", () => {
  const store = () => useAppStore.getState();
  const lines = Array.from(
    { length: 1_200 },
    (_, n) => `<< :platinum.libera.chat 322 syk ##channel${n} 1 :a topic`,
  );

  /** One console pane on `libera` with the log open, and a buffer long enough
   * to have somewhere to scroll to. */
  function openLog(): string {
    act(() => {
      useAppStore.setState({ rawLog: { libera: lines } });
      store().openConsole("libera", true);
    });
    return store().activeViewId!;
  }

  function logs(): HTMLElement[] {
    return screen.getAllByRole("log", { name: "Raw protocol log" });
  }

  it("parks where it is reading, and lets the tail go unparked", async () => {
    const view = openLog();
    render(<PaneTree />);
    await settle();

    logs()[0]!.scrollTop = 900;
    fireEvent.scroll(logs()[0]!);
    expect(store().rawAnchor[view]).toBeGreaterThan(0);

    // All the way down is not a line to come back to, it is the end of the log.
    logs()[0]!.scrollTop = logs()[0]!.scrollHeight;
    fireEvent.scroll(logs()[0]!);
    expect(store().rawAnchor[view]).toBe(null);
  });

  it("comes back to the line it was reading after a split rebuilds it", async () => {
    const view = openLog();
    render(<PaneTree />);
    await settle();

    logs()[0]!.scrollTop = 900;
    fireEvent.scroll(logs()[0]!);
    const parked = store().rawAnchor[view];
    expect(parked).toBeGreaterThan(0);

    // The restore goes through the virtualiser, which scrolls by `scrollTo`,
    // and jsdom has none — the same shim the timeline's rebuild test needs.
    const withoutScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    } as HTMLElement["scrollTo"];
    try {
      act(() => store().splitActiveView("row"));
      await settle();
    } finally {
      HTMLElement.prototype.scrollTo = withoutScrollTo;
    }

    // `newView` opens the second pane on the console rather than on the log,
    // so the window holds one of these either way; the one under test is the
    // pane that was rebuilt around it.
    expect(store().rawAnchor[view]).toBe(parked);
    expect(logs()[0]!.scrollTop).toBeGreaterThan(500);
  });

  /** Two logs on one network read independently, the way two panes on one
   * channel do — the buffer is per network, the place in it is per pane. */
  it("gives two panes on one log their own places in it", async () => {
    const first = openLog();
    act(() => store().splitActiveView("row"));
    const second = store().activeViewId!;
    act(() => store().setViewRaw(second, true));
    render(<PaneTree />);
    await settle();

    expect(logs()).toHaveLength(2);
    logs()[0]!.scrollTop = 400;
    fireEvent.scroll(logs()[0]!);
    logs()[1]!.scrollTop = 3_000;
    fireEvent.scroll(logs()[1]!);

    expect(store().rawAnchor[first]).toBeGreaterThan(0);
    expect(store().rawAnchor[second]).toBeGreaterThan(store().rawAnchor[first]!);
    expect(logs()[0]!.scrollTop).toBe(400);
  });
});
/**
 * The last of #308. `Composer` held the reason a line was refused in component
 * state, so a split took it and left the reader their line back with nothing
 * saying why it had not gone. The line itself survives — it round-trips through
 * the backend draft, which is why this reads as the message being un-sent for
 * no reason rather than as anything being lost.
 */
describe("a composer whose line the server refused", () => {
  const store = () => useAppStore.getState();

  /** The real draft store remembers; the file-wide mock answers null to
   * everything, which would hide the half of this that already works. */
  function rememberDrafts() {
    const drafts = new Map<string, string>();
    ipcMock.getDraft.mockImplementation((n: string, t: string) =>
      Promise.resolve(drafts.get(`${n}/${t}`) ?? null),
    );
    ipcMock.setDraft.mockImplementation((n: string, t: string, v: string) => {
      drafts.set(`${n}/${t}`, v);
      return Promise.resolve();
    });
  }

  async function refuse(reason: string) {
    ipcMock.submitInput.mockResolvedValue({ kind: "rejected", value: reason });
    render(<PaneTree />);
    await settle();
    const box = screen.getByLabelText("Message #ctf-ops");
    fireEvent.change(box, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
  }

  function boxes(): HTMLTextAreaElement[] {
    return screen.getAllByLabelText("Message #ctf-ops") as HTMLTextAreaElement[];
  }

  it("keeps the reason, and the line, when a split rebuilds the pane", async () => {
    rememberDrafts();
    const view = store().activeViewId!;
    await refuse("Cannot send to channel");
    expect(screen.getAllByText(/Cannot send to channel/)).toHaveLength(1);
    expect(boxes()[0]!.value).toBe("hello");

    act(() => store().splitActiveView("row"));
    await settle();
    await settle();

    expect(store().composerError[view]).toBe("Cannot send to channel");
    expect(screen.getAllByText(/Cannot send to channel/)).toHaveLength(1);
    expect(boxes()[0]!.value).toBe("hello");
  });

  it("puts the reason on the pane that tried to send, not on the one beside it", async () => {
    rememberDrafts();
    await refuse("Cannot send to channel");

    act(() => store().splitActiveView("row"));
    await settle();
    await settle();

    expect(store().composerError[store().activeViewId!] ?? null).toBe(null);
    expect(screen.getAllByText(/Cannot send to channel/)).toHaveLength(1);
  });

  it("lets go of the reason when the next line is sent", async () => {
    rememberDrafts();
    const view = store().activeViewId!;
    await refuse("Cannot send to channel");

    ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
    const box = boxes()[0]!;
    fireEvent.change(box, { target: { value: "/help" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(store().composerError[view] ?? null).toBe(null);
    expect(screen.queryByText(/Cannot send to channel/)).toBeNull();
  });
});

describe("resizing the member list", () => {
  /** jsdom lays nothing out, so the column reports whatever it is told to. This
   * is what the drag starts from: the width the pointer is over. */
  function roster(at: number): HTMLElement {
    const column = screen.getByRole("complementary", { name: "#ctf-ops members" });
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      x: 1000 - at,
      y: 0,
      left: 1000 - at,
      top: 0,
      right: 1000,
      bottom: 800,
      width: at,
      height: 800,
      toJSON: () => ({}),
    });
    return column;
  }

  function handle(): HTMLElement {
    const divider = screen.getByRole("separator", { name: "Member list width" });
    divider.setPointerCapture = () => {};
    divider.releasePointerCapture = () => {};
    return divider;
  }

  function drag(from: number, to: number) {
    const divider = handle();
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: from });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: to });
    fireEvent.pointerUp(divider, { pointerId: 1 });
  }

  it("takes the width from the pointer and draws the column there", async () => {
    render(<PaneTree />);
    await settle();
    const column = roster(160);

    // Leftwards is wider: the handle is on the column's near edge.
    drag(840, 780);

    expect(useAppStore.getState().rosterWidth).toBe(220);
    expect(column.style.width).toBe("220px");
  });

  it("holds the drag to the range whatever the pointer does", async () => {
    render(<PaneTree />);
    await settle();
    roster(160);

    drag(840, 300);
    expect(useAppStore.getState().rosterWidth).toBe(400);

    // The same drag, back past the other end. Measured from where the pointer
    // went down rather than from the last move, so a pointer that ran off the
    // range comes back on the pixel it left it.
    drag(840, 1200);
    expect(useAppStore.getState().rosterWidth).toBe(128);
  });

  it("moves it from the keyboard", async () => {
    render(<PaneTree />);
    await settle();
    roster(160);

    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(useAppStore.getState().rosterWidth).toBe(176);
  });

  it("gives the column back to its names when nothing has dragged it", async () => {
    render(<PaneTree />);
    await settle();

    // jsdom drops the `clamp()` the automatic width is written as, so an empty
    // `style.width` is the assertion that no pixel width was set — see
    // `ContextPanel.test.tsx`, which asserts what that clamp says.
    expect(useAppStore.getState().rosterWidth).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "#ctf-ops members" }).style.width,
    ).toBe("");
  });
});
