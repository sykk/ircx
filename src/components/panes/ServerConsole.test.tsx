import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMessage } from "@/components/timeline/fixtures";
import { ESTIMATED_ROW_PX } from "@/components/timeline/Timeline";
import { makeNetwork, oneView, resetStore, TEST_VIEW } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { SERVER_TARGET } from "@/types";
import { ChatPane } from "./ChatPane";
import { PaneTree } from "./PaneTree";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getDraft: vi.fn(),
    setDraft: vi.fn(),
    setTyping: vi.fn(),
    loadHistory: vi.fn(),
    pageBack: vi.fn(),
    submitInput: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn() }));

const CONSOLE = targetKey("libera", SERVER_TARGET);

beforeAll(() => {
  // jsdom lays nothing out, so the virtualiser sees a zero-high viewport and
  // renders no rows.
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
});

/** The rows the live run found sitting in the archive with no window onto them. */
function motd() {
  return [
    makeMessage({
      id: "s1",
      target: SERVER_TARGET,
      kind: "client",
      text: "Connected to irc.libera.chat over TLS 1.3",
    }),
    makeMessage({
      id: "s2",
      target: SERVER_TARGET,
      kind: "server",
      text: "Welcome to the Libera.Chat Internet Relay Chat Network ircx-e39169",
    }),
    makeMessage({
      id: "s3",
      target: SERVER_TARGET,
      kind: "mode",
      text: "ircx-e39169 set mode +Ziw",
    }),
  ];
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  ipcMock.loadHistory.mockResolvedValue([]);
  // The real module answers this without a request for a pane that is not a
  // conversation, which is what the console is.
  ipcMock.pageBack.mockResolvedValue(false);
  ipcMock.submitInput.mockResolvedValue({ kind: "handled" });

  useAppStore.setState({
    networks: { libera: makeNetwork("libera", { name: "Libera.Chat", host: "irc.libera.chat" }) },
    networkOrder: ["libera"],
    timelines: {
      [CONSOLE]: { messages: motd(), unreadFrom: null, hasMore: false, loadingOlder: false, askedBehind: null },
    },
    rawLog: { libera: [">> CAP LS 302", "<< :platinum.libera.chat NOTICE * :*** Checking Ident"] },
    ...oneView({ network: "libera", target: SERVER_TARGET }),
  });
});

function commandBox(): HTMLElement {
  return screen.getByLabelText("Command for Libera.Chat");
}

describe("the server console", () => {
  it("shows what core filed under the server target", () => {
    render(<ChatPane view={TEST_VIEW} />);

    expect(screen.getByText(/Connected to irc.libera.chat over TLS 1.3/)).toBeTruthy();
    expect(screen.getByText(/Welcome to the Libera.Chat/)).toBeTruthy();
    expect(screen.getByText(/set mode \+Ziw/)).toBeTruthy();
  });

  // The live run's 35 rows were in the archive, not in the store. A relaunch
  // reconnects and files one line under `*`; everything above it has to be
  // asked for, under the name core filed it under.
  it("reads the archive for the server target when it opens", async () => {
    useAppStore.setState({
      timelines: {
        [CONSOLE]: {
          messages: [motd()[0]!],
          unreadFrom: null,
          hasMore: true,
          loadingOlder: false, askedBehind: null
        },
      },
    });
    ipcMock.loadHistory.mockResolvedValue(motd().slice(1));
    render(<ChatPane view={TEST_VIEW} />);
    await act(async () => {});

    expect(ipcMock.loadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ network: "libera", target: SERVER_TARGET }),
    );
    expect(screen.getByText(/Welcome to the Libera.Chat/)).toBeTruthy();
  });

  it("names the network it belongs to", () => {
    render(<ChatPane view={TEST_VIEW} />);

    expect(screen.getByRole("heading", { name: "Libera.Chat" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "libera console pane" })).toBeTruthy();
  });

  // A typing notification is a TAGMSG addressed to the pane's target. The
  // console has no recipient, and the live run earned a 411 per keystroke.
  it("reports no typing, because there is nobody to report it to", () => {
    render(<ChatPane view={TEST_VIEW} />);

    fireEvent.change(commandBox(), { target: { value: "/join ##test" } });

    expect(ipcMock.setTyping).not.toHaveBeenCalled();
  });

  it("submits a command against the server target", async () => {
    render(<ChatPane view={TEST_VIEW} />);

    fireEvent.change(commandBox(), { target: { value: "/join ##test" } });
    await act(async () => {
      fireEvent.submit(commandBox());
    });

    expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", SERVER_TARGET, "/join ##test");
    expect((commandBox() as HTMLInputElement).value).toBe("");
  });

  it("says why plain text is refused, and gives it back", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "rejected",
      value: "This tab is the server's, not a conversation. Try `/msg <target> <message>`.",
    });
    render(<ChatPane view={TEST_VIEW} />);

    fireEvent.change(commandBox(), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.submit(commandBox());
    });

    expect(screen.getByRole("alert").textContent).toContain("not a conversation");
    expect((commandBox() as HTMLInputElement).value).toBe("hello");
  });

  // `/help` appends its lines to the target it was typed in (cmd_help ->
  // note_block), so the console draws them through the timeline. Nothing is
  // handed back for the pane to print beside the input.
  it("draws what a command appended to the console", async () => {
    ipcMock.submitInput.mockImplementation((network: string, target: string) => {
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        network,
        target,
        messages: [
          makeMessage({ id: "h1", target, kind: "client", text: "/join #channel [key]" }),
        ],
      });
      return Promise.resolve({ kind: "handled" });
    });
    render(<ChatPane view={TEST_VIEW} />);

    fireEvent.change(commandBox(), { target: { value: "/help" } });
    await act(async () => {
      fireEvent.submit(commandBox());
    });

    expect(screen.getByText("/join #channel [key]")).toBeTruthy();
  });

  // One line and no prose, so the arrows have no caret work to do here and
  // always fetch a command back.
  describe("recalling a command", () => {
    async function submit(command: string) {
      fireEvent.change(commandBox(), { target: { value: command } });
      await act(async () => {
        fireEvent.submit(commandBox());
      });
    }

    it("steps back through what was typed and forward again", async () => {
      render(<ChatPane view={TEST_VIEW} />);
      await submit("/join ##test");
      await submit("/whois phrack");

      fireEvent.keyDown(commandBox(), { key: "ArrowUp" });
      expect((commandBox() as HTMLInputElement).value).toBe("/whois phrack");
      fireEvent.keyDown(commandBox(), { key: "ArrowUp" });
      expect((commandBox() as HTMLInputElement).value).toBe("/join ##test");

      fireEvent.keyDown(commandBox(), { key: "ArrowDown" });
      expect((commandBox() as HTMLInputElement).value).toBe("/whois phrack");
    });

    it("keeps the console's commands apart from a channel's messages", async () => {
      render(<ChatPane view={TEST_VIEW} />);
      await submit("/join ##test");

      expect(useAppStore.getState().inputHistory[CONSOLE]).toEqual(["/join ##test"]);
      expect(useAppStore.getState().inputHistory[targetKey("libera", "##test")]).toBeUndefined();
    });
  });

  describe("the raw protocol log", () => {
    it("is behind the header toggle, with both directions", () => {
      render(<ChatPane view={TEST_VIEW} />);
      expect(screen.queryByRole("log")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Raw protocol log" }));

      const log = screen.getByRole("log", { name: "Raw protocol log" });
      expect(log.textContent).toContain(">> CAP LS 302");
      expect(log.textContent).toContain("<< :platinum.libera.chat NOTICE * :*** Checking Ident");
    });

    /**
     * #119: a `LIST` against Libera writes ~22,000 lines through this buffer,
     * and drawing every line it holds on every arrival froze the window hard
     * enough to need the process killed. The cap is 2,000; what is drawn should
     * be what fits on screen.
     */
    it("draws what fits rather than everything it holds", () => {
      const many = Array.from({ length: 2_000 }, (_, n) => `<< :server 322 syk ##channel${n} 1 :a topic`);
      act(() => useAppStore.setState({ rawLog: { libera: many } }));
      render(<ChatPane view={TEST_VIEW} />);
      fireEvent.click(screen.getByRole("button", { name: "Raw protocol log" }));

      const log = screen.getByRole("log", { name: "Raw protocol log" });
      const drawn = log.querySelectorAll("[data-index]").length;
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThan(200);
    });

    it("goes back to the console", () => {
      render(<ChatPane view={TEST_VIEW} />);
      const toggle = screen.getByRole("button", { name: "Raw protocol log" });

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(toggle);
      expect(screen.queryByRole("log")).toBeNull();
      expect(screen.getByText(/Welcome to the Libera.Chat/)).toBeTruthy();
    });
  });

  /**
   * #308: a change to the pane tree's shape unmounts every pane in it, so
   * anything a pane holds in component state is lost to a split. The console is
   * where that bites, because a command box saves no draft — the refusal is the
   * same one #299 stopped losing, and a split lost it again.
   *
   * Rendered through `PaneTree` rather than as a pane: it is the remount that
   * is under test, and only the tree performs one.
   */
  it("keeps a half-typed command, and the refusal under it, across a split", async () => {
    ipcMock.submitInput.mockResolvedValue({
      kind: "rejected",
      value: "This tab is the server's, not a conversation. Try `/msg <target> <message>`.",
    });
    render(<PaneTree />);

    fireEvent.change(commandBox(), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.submit(commandBox());
    });
    expect(screen.getByRole("alert").textContent).toContain("not a conversation");

    act(() => {
      useAppStore.getState().splitActiveView("row");
    });

    // The pane that was typed in comes first; the one the split opened is a
    // second console on the same network and starts empty, which is what makes
    // this the pane's state rather than the network's.
    const boxes = screen.getAllByLabelText("Command for Libera.Chat") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.value).toBe("hello");
    expect(boxes[1]!.value).toBe("");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  /** A console is a pane, and #297 has to reach it from the same place as a
   * conversation — the pane-restore walk left one of these open in a split. */
  it("can be closed from its own header once the window is split", () => {
    useAppStore.getState().splitActiveView("row");
    render(<ChatPane view={TEST_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));

    expect(useAppStore.getState().viewOrder).not.toContain(TEST_VIEW);
  });
});
