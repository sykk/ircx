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
    connectNetwork: vi.fn(),
    disconnectNetwork: vi.fn(),
    announce: vi.fn(),
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
  ipcMock.connectNetwork.mockResolvedValue(undefined);
  ipcMock.disconnectNetwork.mockResolvedValue(undefined);
  ipcMock.announce.mockResolvedValue(undefined);

  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
    timelines: {},
    replyTo: {},
    inputHistory: {},
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
    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        "the flag is in the env",
        undefined,
      ),
    );
    await waitFor(() => expect(box.value).toBe(""));
  });

  /** #158. `/connect` cannot be sent: what would carry it is the thing that is
   * gone. Both connection commands are performed by the window instead, and
   * the session never sees them. */
  it("performs a connection command here instead of sending it", async () => {
    const box = await mount();
    type(box, "/connect");
    press(box, "Enter");

    await waitFor(() => expect(ipcMock.connectNetwork).toHaveBeenCalledWith("libera"));
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
  });

  it("gives /disconnect the reason that was typed after it", async () => {
    const box = await mount();
    type(box, "/disconnect back later");
    press(box, "Enter");

    await waitFor(() =>
      expect(ipcMock.disconnectNetwork).toHaveBeenCalledWith("libera", "back later"),
    );
  });

  it("leaves the reason out when none was typed", async () => {
    const box = await mount();
    type(box, "/disconnect");
    press(box, "Enter");

    await waitFor(() =>
      expect(ipcMock.disconnectNetwork).toHaveBeenCalledWith("libera", undefined),
    );
  });

  it("shows why the connection refused and does not send it on", async () => {
    ipcMock.connectNetwork.mockRejectedValue("No server configured for libera");
    const box = await mount();
    type(box, "/connect");
    press(box, "Enter");

    expect(await screen.findByText(/No server configured for libera/)).toBeTruthy();
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
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

  /** The Enter that commits an IME candidate arrives with `isComposing` set,
   * and sending on it would post the half-composed line. The composer leaves
   * every composing key to the IME — Tab and the arrows are its candidate
   * list's, too. */
  it("leaves Enter to an open IME composition", async () => {
    const box = await mount();
    type(box, "にほ");
    const event = press(box, "Enter", { isComposing: true });

    expect(event.defaultPrevented).toBe(false);
    expect(ipcMock.submitInput).not.toHaveBeenCalled();
    expect(box.value).toBe("にほ");
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

  /**
   * #318. The refusal was drawn in colour and position and announced to nobody,
   * while the console's identical control was a live region — so a screen
   * reader was told why a command was refused and not why a message was. The
   * assertion is on the role rather than on the text, which the case above
   * already covers and which passed throughout.
   */
  it("announces the refusal rather than only drawing it", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "rejected",
      value: "Cannot send to #ctf-ops",
    });
    const box = await mount();
    type(box, "/nope");
    press(box, "Enter");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Cannot send to #ctf-ops");
  });

  /** Nothing to announce until something is refused: a live region that is
   * present and empty is one a reader is told about for no reason. */
  it("draws no live region while nothing has been refused", async () => {
    await mount();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows why the command never reached the session, and gives the text back", async () => {
    ipcMock.submitInput.mockRejectedValue(
      "ergo stopped responding — reconnect it and try again",
    );
    const box = await mount();
    type(box, "the flag is in the env");
    press(box, "Enter");

    expect(
      await screen.findByText("ergo stopped responding — reconnect it and try again"),
    ).toBeTruthy();
    expect(box.value).toBe("the flag is in the env");
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
    expect(screen.getByText("/join <channel> [key]")).toBeTruthy();

    type(box, "/join #ctf-ops");
    expect(screen.queryByText("/join <channel> [key]")).toBe(null);
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

/**
 * #112. The parent is chosen in the timeline and consumed here, so what the
 * composer has to get right is which message the next line names, and when it
 * stops naming it.
 */
describe("Composer replying", () => {
  function stage(msgid: string, inWindow = true) {
    useAppStore.setState({
      replyTo: { [KEY]: msgid },
      timelines: inWindow
        ? {
            [KEY]: {
              messages: [
                makeMessage({ id: "123", nick: "phrack", text: "the flag is in the env" }),
              ],
              unreadFrom: null,
              hasMore: false,
              loadingOlder: false,
            },
          }
        : {},
    });
  }

  function staged() {
    return useAppStore.getState().replyTo[KEY];
  }

  it("says who is being answered and with what", async () => {
    stage("123");
    await mount();

    expect(screen.getByText("phrack")).toBeTruthy();
    expect(screen.getByText("the flag is in the env")).toBeTruthy();
  });

  /** The msgid alone is enough to send with, so a parent scrolled out of the
   * loaded window leaves nothing to quote and cancels nothing. */
  it("falls back to the msgid when the parent is out of the window", async () => {
    stage("123", false);
    await mount();

    expect(screen.getByText("123")).toBeTruthy();
  });

  it("sends the parent alongside the line", async () => {
    ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
    stage("123");
    const box = await mount();
    type(box, "it is in the env");
    press(box, "Enter");

    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        "it is in the env",
        "123",
      ),
    );
  });

  it("stops naming the parent once a line has said it", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "sent",
      value: makeMessage({ id: "sent-1", nick: "sable", text: "it is in the env" }),
    });
    stage("123");
    const box = await mount();
    type(box, "it is in the env");
    press(box, "Enter");

    await waitFor(() => expect(staged()).toBeUndefined());
  });

  /** A command that says nothing has not answered anybody, so the parent is
   * still waiting when it returns. */
  it("keeps the parent when the input was a command", async () => {
    ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
    stage("123");
    const box = await mount();
    type(box, "/join #elsewhere");
    press(box, "Enter");

    await waitFor(() => expect(ipcMock.submitInput).toHaveBeenCalled());
    expect(staged()).toBe("123");
  });

  it("drops the parent on Escape", async () => {
    stage("123");
    const box = await mount();
    press(box, "Escape");

    expect(staged()).toBeUndefined();
  });

  it("drops the parent when the reply is cancelled", async () => {
    stage("123");
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(staged()).toBeUndefined();
  });
});

/**
 * IRC cannot amend a message it already delivered, so fixing a typo is getting
 * the line back and saying it again. What the composer has to get right is when
 * the arrow fetches a line and when it is still just a caret key.
 */
describe("Composer recall", () => {
  /** Defaults the caret to the edge the key recalls from, which is where the
   * reader pressing it for history has it. */
  function arrow(
    box: HTMLTextAreaElement,
    key: string,
    caret = key === "ArrowUp" ? 0 : box.value.length,
  ) {
    box.selectionStart = caret;
    box.selectionEnd = caret;
    return press(box, key);
  }

  async function afterSending(...lines: string[]) {
    const box = await mount();
    for (const line of lines) {
      type(box, line);
      press(box, "Enter");
      await waitFor(() => expect(box.value).toBe(""));
    }
    return box;
  }

  it("brings the last line back into the box", async () => {
    const box = await afterSending("the flag is in the env");
    const event = arrow(box, "ArrowUp");

    expect(event.defaultPrevented).toBe(true);
    expect(box.value).toBe("the flag is in the env");
  });

  it("walks further back on each press and stops at the oldest", async () => {
    const box = await afterSending("first", "second");
    arrow(box, "ArrowUp");
    expect(box.value).toBe("second");
    arrow(box, "ArrowUp");
    expect(box.value).toBe("first");

    const event = arrow(box, "ArrowUp");
    expect(box.value).toBe("first");
    expect(event.defaultPrevented).toBe(false);
  });

  it("comes forward again and gives back what was being typed", async () => {
    const box = await afterSending("first", "second");
    type(box, "half a thought");
    arrow(box, "ArrowUp");
    arrow(box, "ArrowUp");
    expect(box.value).toBe("first");

    arrow(box, "ArrowDown");
    expect(box.value).toBe("second");
    arrow(box, "ArrowDown");
    expect(box.value).toBe("half a thought");
  });

  it("leaves the arrows alone when nothing has been sent here", async () => {
    const box = await mount();
    const up = arrow(box, "ArrowUp");
    const down = arrow(box, "ArrowDown");

    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(box.value).toBe("");
  });

  /** Recalling replaces the whole box, so anywhere inside the text the arrow
   * has to stay the caret key the reader is using it as. */
  it("moves the caret instead when it is not at the edge", async () => {
    const box = await afterSending("sent");
    type(box, "one\ntwo");

    const up = arrow(box, "ArrowUp", 5);
    expect(up.defaultPrevented).toBe(false);
    expect(box.value).toBe("one\ntwo");

    const down = arrow(box, "ArrowDown", 5);
    expect(down.defaultPrevented).toBe(false);
    expect(box.value).toBe("one\ntwo");
  });

  /**
   * The case that decided the rule. A long line wraps to several rows on screen
   * with no newline anywhere in it, so counting newlines called the middle of it
   * the first line and swapped the box out from under someone moving the caret.
   * Only the caret's own position can tell those apart.
   */
  it("does not recall from inside a line long enough to wrap", async () => {
    const box = await afterSending("sent");
    const wrapped = "a long line with no newline in it that wraps on screen";
    type(box, wrapped);

    const event = arrow(box, "ArrowUp", 20);
    expect(event.defaultPrevented).toBe(false);
    expect(box.value).toBe(wrapped);
  });

  it("recalls once the caret reaches the start, and comes back at the end", async () => {
    const box = await afterSending("sent");
    type(box, "one\ntwo");

    arrow(box, "ArrowUp", 0);
    expect(box.value).toBe("sent");
    arrow(box, "ArrowDown");
    expect(box.value).toBe("one\ntwo");
  });

  /** Selected text is not a caret resting at the edge, whatever it starts at. */
  it("leaves a selection anchored at the start alone", async () => {
    const box = await afterSending("sent");
    type(box, "select me");
    box.selectionStart = 0;
    box.selectionEnd = 9;

    const event = press(box, "ArrowUp");
    expect(event.defaultPrevented).toBe(false);
    expect(box.value).toBe("select me");
  });

  /**
   * Once the box holds history rather than anything typed, stepping on through
   * it is not destroying anything, so it does not ask for the caret again — the
   * caret is left at the end of each recalled line for editing.
   */
  it("keeps stepping without returning the caret to the start", async () => {
    const box = await afterSending("first", "second");
    arrow(box, "ArrowUp");
    expect(box.value).toBe("second");

    const event = arrow(box, "ArrowUp", box.value.length);
    expect(event.defaultPrevented).toBe(true);
    expect(box.value).toBe("first");
  });

  it("stops recalling once the line is edited", async () => {
    const box = await afterSending("first", "second");
    arrow(box, "ArrowUp");
    type(box, "second thoughts");

    arrow(box, "ArrowUp");
    expect(box.value).toBe("second");
    arrow(box, "ArrowDown");
    expect(box.value).toBe("second thoughts");
  });

  /** A line on screen for a look is not a draft. Saving it would lose the one
   * the user actually left half-written. */
  it("keeps the draft as what was typed while a line is recalled", async () => {
    const box = await afterSending("the flag is in the env");
    type(box, "half a thought");
    arrow(box, "ArrowUp");
    expect(box.value).toBe("the flag is in the env");

    await waitFor(() =>
      expect(ipcMock.setDraft).toHaveBeenLastCalledWith(
        "libera",
        "#ctf-ops",
        "half a thought",
      ),
    );
  });

  it("still has the lines after the conversation is left and returned to", async () => {
    const { unmount } = render(<Composer view={TEST_VIEW} />);
    const first = screen.getByLabelText("Message #ctf-ops") as HTMLTextAreaElement;
    await waitFor(() => expect(ipcMock.getDraft).toHaveBeenCalled());
    await act(async () => {});
    type(first, "the flag is in the env");
    press(first, "Enter");
    await waitFor(() => expect(first.value).toBe(""));
    unmount();

    const box = await mount();
    arrow(box, "ArrowUp");
    expect(box.value).toBe("the flag is in the env");
  });

  it("recalls a command the server refused", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "rejected",
      value: "Cannot send to #ctf-ops",
    });
    const box = await mount();
    type(box, "/whois nobodu");
    press(box, "Enter");
    await screen.findByText("Cannot send to #ctf-ops");
    type(box, "");

    arrow(box, "ArrowUp");
    expect(box.value).toBe("/whois nobodu");
  });
});

function queue(pending: number) {
  const messages = Array.from({ length: pending }, (_, i) => {
    const message = makeMessage({ id: `q${i}`, nick: "sable", delivery: { state: "pending" } });
    message.sender.isSelf = true;
    return message;
  });
  useAppStore.setState({
    timelines: { [KEY]: { messages, unreadFrom: null, hasMore: false, loadingOlder: false } },
  });
}

describe("what is waiting to send", () => {
  it("keeps the hint while nothing is queued", async () => {
    await mount();
    expect(screen.getByText("Markdown is supported")).toBeTruthy();
  });

  /** One is every message between Enter and the socket, so saying it would
   * twitch the row on ordinary typing without telling anyone anything. */
  it("says nothing about a single line in flight", async () => {
    queue(1);
    await mount();
    expect(screen.getByText("Markdown is supported")).toBeTruthy();
  });

  it("counts the queue once a line is waiting behind another", async () => {
    queue(12);
    await mount();
    expect(screen.getByText("12 waiting to send")).toBeTruthy();
    expect(screen.queryByText("Markdown is supported")).toBeNull();
  });
});

describe("what a reader is told about the queue", () => {
  const said = () => screen.getByRole("status").textContent;

  it("is silent in a conversation with nothing queued", async () => {
    await mount();
    expect(said()).toBe("");
  });

  /** The whole point of the region. A polite one holds every change it is
   * given, so a count would still be reading numbers out after the queue had
   * gone. This says a queue formed and then stops. */
  it("says a queue formed and does not say it again as it drains", async () => {
    queue(40);
    await mount();
    expect(said()).toBe("Messages waiting to send");

    act(() => queue(12));
    expect(said()).toBe("Messages waiting to send");
    act(() => queue(2));
    expect(said()).toBe("Messages waiting to send");
  });

  /** One left is still one not sent. The row stops counting at two because a
   * single line in flight is every message ever typed; the sentence "all sent"
   * has to mean it. */
  it("waits for the last line before saying everything has gone", async () => {
    queue(40);
    await mount();

    act(() => queue(1));
    expect(said()).toBe("Messages waiting to send");
    act(() => queue(0));
    expect(said()).toBe("All sent");
  });

  it("stays silent for a line that was never a queue", async () => {
    queue(1);
    await mount();

    act(() => queue(0));
    expect(said()).toBe("");
  });
});
