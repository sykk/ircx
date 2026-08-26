import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, resetStore } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";

const { insideTauri, ipcMock, onIrcxEvent, windowMock } = vi.hoisted(() => ({
  insideTauri: vi.fn(),
  ipcMock: {
    getSnapshot: vi.fn(),
    listMembers: vi.fn(),
    markRead: vi.fn(),
    listBookmarks: vi.fn(),
    listTransfers: vi.fn(),
  },
  onIrcxEvent: vi.fn(),
  windowMock: {
    isFocused: vi.fn(),
    onFocusChanged: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ insideTauri, ipc: ipcMock, onIrcxEvent }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowMock }));

const { startBridge } = await import("./bridge");

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  insideTauri.mockReturnValue(false);
  ipcMock.getSnapshot.mockResolvedValue({ networks: [], channels: [], queries: [], drafts: [] });
  ipcMock.listMembers.mockResolvedValue([]);
  ipcMock.markRead.mockResolvedValue(undefined);
  ipcMock.listBookmarks.mockResolvedValue([]);
  ipcMock.listTransfers.mockResolvedValue([]);
  onIrcxEvent.mockResolvedValue(() => {});
  windowMock.isFocused.mockResolvedValue(true);
  windowMock.onFocusChanged.mockResolvedValue(() => {});
});

it("loads persisted draft identities without loading their text", async () => {
  ipcMock.getSnapshot.mockResolvedValue({
    networks: [],
    channels: [],
    queries: [],
    drafts: [{ network: "libera", target: "#ctf-ops" }],
  });

  const stop = await startBridge();

  expect(useAppStore.getState().drafts).toEqual({ "libera\0#ctf-ops": true });
  stop();
});

/**
 * The transfer list is the least of the three reads that start the window, and
 * awaiting it beside the other two meant a refusal emptied everything: no
 * networks, no channels, no queries. #645 shipped it that way, and the seeded
 * harness — which had no handler for it — came up saying no networks were
 * configured, which reads as a broken client rather than a missing stub.
 */
it("still loads the conversations when the transfer list cannot be read", async () => {
  ipcMock.getSnapshot.mockResolvedValue({
    networks: [{ id: "libera", name: "Libera.Chat" }],
    channels: [],
    queries: [],
    drafts: [],
  });
  ipcMock.listTransfers.mockRejectedValue("the session stopped responding");

  const stop = await startBridge();

  expect(Object.keys(useAppStore.getState().networks)).toEqual(["libera"]);
  stop();
});

/**
 * #133: `mark_read` is the only thing that resets a conversation's unread count
 * and nothing called it, so a badge in the sidebar only ever grew.
 *
 * The count lives in core, so telling it is the whole of the behaviour and
 * there is nothing local to assert instead. What is worth asserting is the rule
 * around the telling: which moments count as reading, and which do not.
 */
describe("marking a conversation read", () => {
  it("tells the backend when a pane takes focus on a conversation", async () => {
    const stop = await startBridge();
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });

    expect(ipcMock.markRead).toHaveBeenCalledWith("libera", "#ctf-ops");
    stop();
  });

  it("says so once for a conversation, not on every change around it", async () => {
    const stop = await startBridge();
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    // Anything else touching the store must not look like reading it again.
    store.openSearch();
    store.setActive({ network: "libera", target: "#ctf-ops" });

    expect(ipcMock.markRead).toHaveBeenCalledTimes(1);
    stop();
  });

  it("says so again when unread grows in the focused conversation", async () => {
    const stop = await startBridge();
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    ipcMock.markRead.mockClear();

    store.applyEvent({
      type: "channelUpdated",
      channel: makeChannel("libera", "#ctf-ops", { unread: 1 }),
    });

    expect(ipcMock.markRead).toHaveBeenCalledWith("libera", "#ctf-ops");
    stop();
  });

  it("keeps unread while blurred and clears it on refocus", async () => {
    insideTauri.mockReturnValue(true);
    const stop = await startBridge();
    await vi.waitFor(() => expect(windowMock.onFocusChanged).toHaveBeenCalled());
    const changed = windowMock.onFocusChanged.mock.calls[0]?.[0];
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    ipcMock.markRead.mockClear();

    changed?.({ payload: false });
    store.applyEvent({
      type: "channelUpdated",
      channel: makeChannel("libera", "#ctf-ops", { unread: 1 }),
    });
    expect(ipcMock.markRead).not.toHaveBeenCalled();

    changed?.({ payload: true });
    expect(ipcMock.markRead).toHaveBeenCalledWith("libera", "#ctf-ops");
    stop();
  });

  it("does not let a late focus query overwrite a newer blur", async () => {
    let resolveFocus: ((focused: boolean) => void) | undefined;
    windowMock.isFocused.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveFocus = resolve;
      }),
    );
    insideTauri.mockReturnValue(true);
    const stop = await startBridge();
    await vi.waitFor(() => expect(windowMock.onFocusChanged).toHaveBeenCalled());
    const changed = windowMock.onFocusChanged.mock.calls[0]?.[0];
    changed?.({ payload: false });
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });
    ipcMock.markRead.mockClear();

    resolveFocus?.(true);
    await Promise.resolve();

    expect(ipcMock.markRead).not.toHaveBeenCalled();
    stop();
  });

  it("ignores a focus callback already in flight after cleanup", async () => {
    insideTauri.mockReturnValue(true);
    const stop = await startBridge();
    await vi.waitFor(() => expect(windowMock.onFocusChanged).toHaveBeenCalled());
    const changed = windowMock.onFocusChanged.mock.calls[0]?.[0];
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });
    ipcMock.markRead.mockClear();

    stop();
    changed?.({ payload: true });

    expect(ipcMock.markRead).not.toHaveBeenCalled();
  });

  it("says so again when focus moves to a different conversation", async () => {
    const stop = await startBridge();
    const store = useAppStore.getState();
    store.setActive({ network: "libera", target: "#ctf-ops" });
    store.setActive({ network: "libera", target: "#hackint" });

    expect(ipcMock.markRead).toHaveBeenCalledTimes(2);
    expect(ipcMock.markRead).toHaveBeenLastCalledWith("libera", "#hackint");
    stop();
  });

  it("stops when the bridge does", async () => {
    const stop = await startBridge();
    stop();
    useAppStore.getState().setActive({ network: "libera", target: "#ctf-ops" });

    expect(ipcMock.markRead).not.toHaveBeenCalled();
  });
});
