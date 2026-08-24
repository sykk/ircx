import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { makeMessage } from "@/components/timeline/fixtures";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { openNotification } from "./notificationRouting";

const loadHistoryAround = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", () => ({
  insideTauri: () => false,
  ipc: { loadHistoryAround },
}));

const ROUTE = { network: "libera", target: "#ircx", messageId: "message-1" };

describe("notification activation", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ircx")]);
  });

  it("opens and centers a message in the current window", async () => {
    const message = makeMessage({ id: ROUTE.messageId, network: "libera", target: "#ircx" });
    useAppStore.getState().applyEvent({
      type: "messagesAppended",
      network: "libera",
      target: "#ircx",
      messages: [message],
      answers: null,
    });

    await openNotification(ROUTE);

    expect(loadHistoryAround).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.views[state.activeViewId!]?.target).toBe("#ircx");
    expect(state.messageJump[state.activeViewId!]).toBe(ROUTE.messageId);
  });

  it("loads an archived message before centering it", async () => {
    const message = makeMessage({ id: ROUTE.messageId, network: "libera", target: "#ircx" });
    loadHistoryAround.mockResolvedValue([message]);

    await openNotification(ROUTE);

    expect(loadHistoryAround).toHaveBeenCalledWith("libera", "#ircx", ROUTE.messageId, 100);
    expect(useAppStore.getState().timelines[targetKey("libera", "#ircx")]?.messages).toEqual([
      message,
    ]);
    expect(useAppStore.getState().messageJump[useAppStore.getState().activeViewId!]).toBe(
      ROUTE.messageId,
    );
  });

  it("opens the conversation when the archived message is gone", async () => {
    loadHistoryAround.mockResolvedValue([]);

    await openNotification(ROUTE);

    const state = useAppStore.getState();
    expect(state.views[state.activeViewId!]?.target).toBe("#ircx");
    expect(state.messageJump[state.activeViewId!]).toBeUndefined();
  });
});
