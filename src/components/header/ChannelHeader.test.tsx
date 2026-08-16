import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { CTF_OPS, LIBERA } from "@/components/drawer/fixtures";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ChannelHeader, formatTopicTimestamp } from "./ChannelHeader";
import { makeMessage } from "@/components/timeline/fixtures";

const TOPIC = "CTF discussions and operations — pwn-300 heap notes and flag drops";

beforeEach(() => {
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", CTF_OPS.name)]: {
        ...CTF_OPS,
        topic: { text: TOPIC, setBy: "sable", setAt: "2026-05-25T17:25:00Z" },
      },
    },
    ...oneView({ network: "libera", target: CTF_OPS.name }),
    rosterHidden: {},
    searchOpen: false,
    timelines: {
      [targetKey("libera", CTF_OPS.name)]: {
        messages: [makeMessage({ id: "current", target: CTF_OPS.name })],
        unreadFrom: "current",
        hasMore: true,
        loadingOlder: false,
        askedBehind: "older",
      },
      [targetKey("libera", "#rust")]: {
        messages: [makeMessage({ id: "other", target: "#rust" })],
        unreadFrom: null,
        hasMore: true,
        loadingOlder: false,
        askedBehind: null,
      },
    },
    setup: null,
  });
});

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
}

describe("ChannelHeader", () => {
  it("renders nothing when no channel is active", () => {
    useAppStore.setState(oneView(null));
    const { container } = render(<ChannelHeader view={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the channel and counts its members", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    expect(screen.getByRole("heading", { name: CTF_OPS.name })).toBeTruthy();
    expect(screen.getByText("16 members")).toBeTruthy();
  });

  it("exposes the catch-up filter as a pressed header action", () => {
    const onCatchUp = vi.fn();
    render(<ChannelHeader view={TEST_VIEW} catchUp onCatchUp={onCatchUp} />);

    const button = screen.getByRole("button", { name: "Catch up" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onCatchUp).toHaveBeenCalledOnce();
  });

  /** #345: the topic crossed every layer and no component drew it, so it was
   * visible for as long as the line announcing it stayed on screen. This test
   * used to assert the opposite — the header dropped the topic in #32 for not
   * being in the mockup, before anything had established that nothing else
   * showed it either. */
  describe("the topic", () => {
    it("is drawn in a separate banner below the controls", () => {
      const { container } = render(<ChannelHeader view={TEST_VIEW} />);
      const controls = container.querySelector('[data-ui="channel-header-row"]');
      const banner = container.querySelector('[data-ui="topic-banner"]');
      expect(controls).toBeTruthy();
      expect(banner).toBeTruthy();
      expect(controls?.contains(screen.getByText(TOPIC))).toBe(false);
      expect(banner?.contains(screen.getByText(TOPIC))).toBe(true);
    });

    it("shows who set it and when", () => {
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.getByText("Set by sable on 2026-05-25 at 17:25 UTC")).toBeTruthy();
    });

    it("expands the full topic and collapses it to one line", () => {
      render(<ChannelHeader view={TEST_VIEW} />);
      const topic = screen.getByText(TOPIC);

      expect(topic.className).toContain("whitespace-pre-wrap");
      expect(topic.className).not.toContain("truncate");
      fireEvent.click(screen.getByRole("button", { name: "Collapse topic" }));

      expect(topic.className).toContain("truncate");
      expect(topic.className).not.toContain("whitespace-pre-wrap");
      expect(screen.queryByText(/Set by sable/)).toBeNull();
      expect(screen.getByRole("button", { name: "Expand topic" }).getAttribute("aria-expanded"))
        .toBe("false");
    });

    /** A long one truncates rather than pushing the controls off the end, so
     * the whole of it has to be readable some other way. */
    it("carries the whole of itself for a truncated one to be read by", () => {
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.getByText(TOPIC)).toHaveProperty("title", TOPIC);
    });

    it("draws nothing where a channel has none", () => {
      useAppStore.setState({
        channels: { [targetKey("libera", CTF_OPS.name)]: { ...CTF_OPS, topic: null } },
      });
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.queryByText(TOPIC)).toBeNull();
      expect(screen.getByText("16 members")).toBeTruthy();
      expect(document.querySelector('[data-ui="topic-banner"]')).toBeNull();
    });

    /** A server that clears a topic sends an empty one rather than none. */
    it("draws nothing for a topic that was cleared", () => {
      useAppStore.setState({
        channels: {
          [targetKey("libera", CTF_OPS.name)]: {
            ...CTF_OPS,
            topic: { text: "", setBy: "sable", setAt: null },
          },
        },
      });
      const { container } = render(<ChannelHeader view={TEST_VIEW} />);
      expect(container.querySelector("p")).toBeNull();
    });
  });

  it("formats topic timestamps in UTC", () => {
    expect(formatTopicTimestamp("2026-05-25T13:25:00-04:00")).toBe(
      "2026-05-25 at 17:25 UTC",
    );
    expect(formatTopicTimestamp("server time unavailable")).toBe("server time unavailable");
  });

  it("hides and shows this pane's member list", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    const toggle = screen.getByRole("button", { name: "Toggle member list" });
    // Shown to begin with: a roster is part of the conversation, not something
    // the user has to ask for.
    expect(useAppStore.getState().rosterHidden[TEST_VIEW]).not.toBe(true);

    fireEvent.click(toggle);
    expect(useAppStore.getState().rosterHidden[TEST_VIEW]).toBe(true);
    fireEvent.click(toggle);
    expect(useAppStore.getState().rosterHidden[TEST_VIEW]).toBe(false);
  });

  it("opens search for the channel", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: `Search ${CTF_OPS.name}` }));
    expect(useAppStore.getState().searchOpen).toBe(true);
  });

  it("clears only this conversation's buffer", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: `Clear ${CTF_OPS.name} buffer` }));

    const state = useAppStore.getState();
    expect(state.timelines[targetKey("libera", CTF_OPS.name)]).toEqual({
      messages: [],
      unreadFrom: null,
      hasMore: false,
      loadingOlder: false,
      askedBehind: null,
    });
    expect(state.timelines[targetKey("libera", "#rust")]?.messages[0]?.id).toBe("other");
  });

  it("keeps invite in the overflow menu, and asks for a nick", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    expect(screen.queryByRole("menuitem", { name: "Invite" })).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite" }));
    expect(screen.getByLabelText(`Nick to invite to ${CTF_OPS.name}`)).toBeTruthy();
  });

  it("reaches the network's settings from the overflow menu", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: `${LIBERA.name} settings` }));

    expect(useAppStore.getState().setup).toEqual({ network: "libera" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the overflow menu on Escape", () => {
    render(<ChannelHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite" }));

    const field = screen.getByLabelText(`Nick to invite to ${CTF_OPS.name}`);
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByLabelText(/Nick to invite/)).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  /** #297: a split could be made with a drag and unmade only with a chord, so
   * what people reached for was closing the conversation the pane showed. */
  describe("closing the pane", () => {
    it("offers nothing while the window holds one pane", () => {
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    });

    it("offers a close once the window is split", () => {
      useAppStore.getState().splitActiveView("row");
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.getByRole("button", { name: "Close pane" })).toBeTruthy();
    });

    it("closes the pane it is drawn in rather than the focused one", () => {
      useAppStore.getState().splitActiveView("row");
      // Splitting focuses the pane it opened, so the two differ here — which is
      // the case a header reading `activeViewId` instead of its own view would
      // get wrong.
      const opened = useAppStore.getState().activeViewId;
      expect(opened).not.toBe(TEST_VIEW);

      render(<ChannelHeader view={TEST_VIEW} />);
      fireEvent.click(screen.getByRole("button", { name: "Close pane" }));

      expect(useAppStore.getState().viewOrder).toEqual([opened]);
    });
  });
});
