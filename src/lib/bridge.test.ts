import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";

const { ipcMock, onIrcxEvent } = vi.hoisted(() => ({
  ipcMock: {
    getSnapshot: vi.fn(),
    listMembers: vi.fn(),
    markRead: vi.fn(),
  },
  onIrcxEvent: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent }));

const { startBridge } = await import("./bridge");

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  ipcMock.getSnapshot.mockResolvedValue({ networks: [], channels: [], queries: [], drafts: [] });
  ipcMock.listMembers.mockResolvedValue([]);
  ipcMock.markRead.mockResolvedValue(undefined);
  onIrcxEvent.mockResolvedValue(() => {});
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
    store.toggleSearch(true);
    store.setActive({ network: "libera", target: "#ctf-ops" });

    expect(ipcMock.markRead).toHaveBeenCalledTimes(1);
    stop();
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
