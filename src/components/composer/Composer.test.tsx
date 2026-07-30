import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { makeMessage } from "@/components/timeline/fixtures";
import { Composer } from "./Composer";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getDraft: vi.fn(),
    setDraft: vi.fn(),
    setTyping: vi.fn(),
    submitInput: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn() }));

const KEY = targetKey("libera", "#ctf-ops");

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.getDraft.mockResolvedValue(null);
  ipcMock.setDraft.mockResolvedValue(undefined);
  ipcMock.setTyping.mockResolvedValue(undefined);
  ipcMock.submitInput.mockResolvedValue({ kind: "handled" });

  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
    timelines: {},
    members: {
      [KEY]: ["sable", "sableton", "phrack", "nyx"].map((nick) => ({
        nick,
        account: null,
        prefixes: [],
        away: null,
      })),
    },
  });
});

async function mount() {
  render(<Composer view={TEST_VIEW} />);
  const box = screen.getByLabelText("Message #ctf-ops") as HTMLTextAreaElement;
  await waitFor(() => expect(ipcMock.getDraft).toHaveBeenCalled());
  await act(async () => {});
  return box;
}

function type(box: HTMLTextAreaElement, value: string) {
  fireEvent.change(box, { target: { value } });
  box.selectionStart = value.length;
  box.selectionEnd = value.length;
}

function press(box: HTMLTextAreaElement, key: string, init: object = {}) {
  const event = createEvent.keyDown(box, { key, ...init });
  fireEvent(box, event);
  return event;
}

describe("Composer sending", () => {
  it("sends on Enter and clears the box", async () => {
    const box = await mount();
    type(box, "the flag is in the env");
    const event = press(box, "Enter");

    expect(event.defaultPrevented).toBe(true);
    expect(ipcMock.submitInput).toHaveBeenCalledWith(
      "libera",
      "#ctf-ops",
      "the flag is in the env",
    );
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("draws the local copy the backend hands back, before any echo", async () => {
    const local = makeMessage({
      id: "local-1",
      nick: "sable",
      text: "the flag is in the env",
      delivery: { state: "sent" },
    });
    local.sender.isSelf = true;
    ipcMock.submitInput.mockResolvedValue({ kind: "sent", value: local });

    const box = await mount();
    type(box, "the flag is in the env");
    press(box, "Enter");

    await waitFor(() =>
      expect(useAppStore.getState().timelines[KEY]?.messages).toEqual([local]),
    );
  });

  it("does not raise its own unread rule over a line the user just typed", async () => {
    const local = makeMessage({ id: "local-1", nick: "sable", text: "mine" });
    local.sender.isSelf = true;
    ipcMock.submitInput.mockResolvedValue({ kind: "sent", value: local });

    const box = await mount();
    type(box, "mine");
    press(box, "Enter");

    await waitFor(() => expect(useAppStore.getState().timelines[KEY]).toBeTruthy());
    expect(useAppStore.getState().timelines[KEY]?.unreadFrom).toBe(null);
  });

  it("leaves Shift+Enter to the textarea", async () => {
    const box = await mount();
    type(box, "one");
    const event = press(box, "Enter", { shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
    expect(box.value).toBe("one");
  });

  it("ignores Enter on an empty box", async () => {
    const box = await mount();
    press(box, "Enter");
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
  });

  it("shows why the backend refused and gives the text back", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "rejected",
      value: "Cannot send to #ctf-ops",
    });
    const box = await mount();
    type(box, "/nope");
    press(box, "Enter");

    expect(await screen.findByText("Cannot send to #ctf-ops")).toBeTruthy();
    expect(box.value).toBe("/nope");
  });
});

describe("Composer completion", () => {
  it("completes a nick at the start of a line with a colon", async () => {
    const box = await mount();
    type(box, "sab");
    const event = press(box, "Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(box.value).toBe("sable: ");
  });

  it("cycles through the matches on repeated Tab", async () => {
    const box = await mount();
    type(box, "sab");
    press(box, "Tab");
    press(box, "Tab");
    expect(box.value).toBe("sableton: ");
    press(box, "Tab");
    expect(box.value).toBe("sable: ");
  });

  it("completes mid-sentence without a colon", async () => {
    const box = await mount();
    type(box, "ask phr");
    press(box, "Tab");
    expect(box.value).toBe("ask phrack ");
  });

  it("restarts the cycle after the text changes", async () => {
    const box = await mount();
    type(box, "sab");
    press(box, "Tab");
    press(box, "Tab");
    expect(box.value).toBe("sableton: ");

    type(box, "ny");
    press(box, "Tab");
    expect(box.value).toBe("nyx: ");
  });

  it("completes a slash command instead of a nick", async () => {
    const box = await mount();
    type(box, "/jo");
    press(box, "Tab");
    expect(box.value).toBe("/join ");
  });

  it("leaves an unmatched word alone", async () => {
    const box = await mount();
    type(box, "zzz");
    press(box, "Tab");
    expect(box.value).toBe("zzz");
  });
});

describe("Composer hints", () => {
  it("lists matching commands as they are typed", async () => {
    const box = await mount();
    type(box, "/jo");
    expect(screen.getByText("/join #channel [key]")).toBeTruthy();

    type(box, "/join #ctf-ops");
    expect(screen.queryByText("/join #channel [key]")).toBe(null);
  });
});

describe("Composer drafts and typing", () => {
  it("restores the stored draft", async () => {
    ipcMock.getDraft.mockResolvedValue("half a thought");
    const box = await mount();
    await waitFor(() => expect(box.value).toBe("half a thought"));
  });

  it("saves the draft after a pause, not on every keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const box = await mount();
      type(box, "typ");
      type(box, "typing");
      expect(ipcMock.setDraft).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(ipcMock.setDraft).toHaveBeenCalledTimes(1);
      expect(ipcMock.setDraft).toHaveBeenCalledWith("libera", "#ctf-ops", "typing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces typing once per burst and stops on send", async () => {
    const box = await mount();
    type(box, "a");
    type(box, "a b");
    type(box, "a burst");
    expect(ipcMock.setTyping.mock.calls.filter((c) => c[2] === true)).toHaveLength(1);

    press(box, "Enter");
    expect(ipcMock.setTyping).toHaveBeenLastCalledWith("libera", "#ctf-ops", false);
  });

  it("stops the indicator when the box is emptied", async () => {
    const box = await mount();
    type(box, "x");
    type(box, "");
    expect(ipcMock.setTyping).toHaveBeenLastCalledWith("libera", "#ctf-ops", false);
  });
});
