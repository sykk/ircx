import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { CTF_OPS, LIBERA } from "@/components/drawer/fixtures";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { ChannelHeader } from "./ChannelHeader";

const TOPIC = "CTF discussions and operations — pwn-300 heap notes and flag drops";

beforeEach(() => {
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", CTF_OPS.name)]: {
        ...CTF_OPS,
        topic: { text: TOPIC, setBy: "sable", setAt: null },
      },
    },
    ...oneView({ network: "libera", target: CTF_OPS.name }),
    rosterHidden: {},
    searchOpen: false,
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

  /** #345: the topic crossed every layer and no component drew it, so it was
   * visible for as long as the line announcing it stayed on screen. This test
   * used to assert the opposite — the header dropped the topic in #32 for not
   * being in the mockup, before anything had established that nothing else
   * showed it either. */
  describe("the topic", () => {
    it("is drawn beside the count", () => {
      render(<ChannelHeader view={TEST_VIEW} />);
      expect(screen.getByText(TOPIC)).toBeTruthy();
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
