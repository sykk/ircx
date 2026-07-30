import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "@/components/drawer/Drawer";
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
    drawerOpen: true,
    contextMode: "follow",
    contextPane: null,
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

  it("moves the context panel to the pane that takes focus", async () => {
    const [first] = split("row");
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#hackint" }));
    render(
      <>
        <PaneTree />
        <Drawer />
      </>,
    );
    await settle();

    expect(screen.getByRole("complementary").getAttribute("aria-label")).toBe(
      "#hackint members",
    );

    fireEvent.pointerDown(screen.getAllByTestId("timeline-scroller")[0]!);

    expect(useAppStore.getState().activeViewId).toBe(first);
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toBe(
      "#ctf-ops members",
    );
  });
});

describe("context panel modes", () => {
  /** Two panes on different channels, focus on the second, panel and all. */
  async function twoPanes(): Promise<[string, string]> {
    const ids = split("row");
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#hackint" }));
    render(
      <>
        <PaneTree />
        <Drawer />
      </>,
    );
    await settle();
    return ids;
  }

  function chooseMode(label: string) {
    fireEvent.click(screen.getByRole("button", { name: "Panel placement" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
  }

  function panelLabel(): string | null {
    return screen.getByRole("complementary").getAttribute("aria-label");
  }

  it("holds the panel on the pinned pane while focus moves away", async () => {
    const [first] = await twoPanes();
    expect(panelLabel()).toBe("#hackint members");

    chooseMode("Pin to this pane");
    fireEvent.pointerDown(screen.getAllByTestId("timeline-scroller")[0]!);

    expect(useAppStore.getState().activeViewId).toBe(first);
    expect(panelLabel()).toBe("#hackint members");
  });

  it("says which pane it is holding, so a stale roster does not read as a bug", async () => {
    await twoPanes();
    chooseMode("Pin to this pane");

    expect(within(screen.getByRole("complementary")).getByText("Pinned")).toBeTruthy();
  });

  it("moves the panel inside its pane when embedded, and out of the sidebar", async () => {
    const [, second] = await twoPanes();
    chooseMode("Show inside this pane");

    const panel = screen.getByRole("complementary");
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(panes().find((pane) => pane.contains(panel))?.dataset["view"]).toBe(second);
  });

  it("comes back to the sidebar from the panel's own header", async () => {
    await twoPanes();
    chooseMode("Show inside this pane");
    chooseMode("Follow the focused pane");

    const panel = screen.getByRole("complementary");
    expect(panes().some((pane) => pane.contains(panel))).toBe(false);
  });

  it("goes back to following when the pane it was pinned to closes", async () => {
    const [, second] = await twoPanes();
    chooseMode("Pin to this pane");

    act(() => useAppStore.getState().closeView(second));
    await settle();

    expect(useAppStore.getState().contextMode).toBe("follow");
    expect(useAppStore.getState().contextPane).toBeNull();
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
