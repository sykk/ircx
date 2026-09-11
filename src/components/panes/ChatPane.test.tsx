import { render, screen } from "@testing-library/react";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oneView, makeNetwork, makeQuery, resetStore, TEST_VIEW } from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { ChatPane } from "./ChatPane";

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

beforeAll(() => {
  // jsdom lays nothing out, so the timeline's virtualiser needs a stand-in —
  // see PaneTree.test.tsx, which this copies for the same reason.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.getDraft.mockResolvedValue(null);
  ipcMock.setDraft.mockResolvedValue(undefined);
  ipcMock.setTyping.mockResolvedValue(undefined);
  ipcMock.loadHistory.mockResolvedValue([]);
  resetStore();
});

/** Lets a mounting pane's draft lookup resolve. */
async function settle() {
  await act(async () => {});
}

describe("ChatPane roster column", () => {
  /**
   * A query has no member list — `useChannelForView` returns `undefined` for
   * one, and `ContextPanel` itself draws nothing on that. But the column that
   * wraps it used to render whenever `rosterHidden` was not explicitly `true`,
   * which it never is for a query: nothing offers a toggle for one. The empty
   * column still claimed grid-column 2 for the whole pane height, including
   * the header's row, and the header's `col-span-2` title bar — needing both
   * columns because a query has no second column to share the row with — had
   * nowhere to go but new implicit columns 3 and 4. Those took real width from
   * column 1, the one thing every row of the pane actually draws in, and a
   * split pane could squeeze it down to single-character line wrapping. This
   * is a DOM-presence assertion rather than one on layout, per the note in
   * `scripts/run-ircx/SKILL.md`: jsdom does not compute grid tracks, so the
   * only part of this bug it can see is the phantom column being there at all.
   */
  it("draws no roster column for a query, even with the roster not hidden", async () => {
    const network = makeNetwork("net1");
    const query = makeQuery("net1", "sable");
    useAppStore.setState({
      networks: { net1: network },
      networkOrder: ["net1"],
      queries: { [targetKey("net1", "sable")]: query },
      rosterHidden: {},
      ...oneView({ network: "net1", target: "sable" }),
    });

    render(<ChatPane view={TEST_VIEW} />);
    await settle();

    // Throws if the composer did not mount at all, which is the sign a wrong
    // selector rather than a query pane's absent roster would produce.
    screen.getByLabelText("Message sable");
    expect(document.querySelector('[data-ui="roster-column"]')).toBeNull();
  });
});
