import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_TARGET } from "@/types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { ipc } = await import("./ipc");

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
});

describe("setTyping", () => {
  it("reports typing in a channel", async () => {
    await ipc.setTyping("libera", "#ctf-ops", true);

    expect(invoke).toHaveBeenCalledWith("set_typing", {
      network: "libera",
      target: "#ctf-ops",
      active: true,
    });
  });

  // A TAGMSG with no recipient is a protocol error the server answers with 411,
  // once per keystroke. The console is a pane, not a conversation.
  it("stays off the wire for the server console", async () => {
    await ipc.setTyping("libera", SERVER_TARGET, true);
    await ipc.setTyping("libera", "", true);

    expect(invoke).not.toHaveBeenCalled();
  });
});
