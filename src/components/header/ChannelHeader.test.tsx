import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { CTF_OPS, LIBERA } from "@/components/drawer/fixtures";
import { ChannelHeader } from "./ChannelHeader";

const LONG_TOPIC =
  "CTF discussions and operations — pwn-300 heap notes, flag drops, and the " +
  "rotation for the next qualifier weekend";

beforeEach(() => {
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", CTF_OPS.name)]: {
        ...CTF_OPS,
        topic: { text: LONG_TOPIC, setBy: "sable", setAt: null },
      },
    },
    active: { network: "libera", target: CTF_OPS.name },
    drawerOpen: false,
    searchOpen: false,
  });
});

describe("ChannelHeader", () => {
  it("renders nothing when no channel is active", () => {
    useAppStore.setState({ active: null });
    const { container } = render(<ChannelHeader />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the topic to one line and hands the whole thing to the tooltip", () => {
    render(<ChannelHeader />);
    const topic = screen.getByText(LONG_TOPIC);
    expect(topic.className).toContain("truncate");
    expect(topic).toHaveProperty("title", LONG_TOPIC);
  });

  it("shows the member count", () => {
    render(<ChannelHeader />);
    expect(screen.getByTitle(`16 members in ${CTF_OPS.name}`).textContent).toContain(
      "16",
    );
  });

  it("toggles the drawer", () => {
    render(<ChannelHeader />);
    const toggle = screen.getByRole("button", { name: "Toggle member drawer" });
    fireEvent.click(toggle);
    expect(useAppStore.getState().drawerOpen).toBe(true);
    fireEvent.click(toggle);
    expect(useAppStore.getState().drawerOpen).toBe(false);
  });

  it("opens search for the channel", () => {
    render(<ChannelHeader />);
    fireEvent.click(screen.getByRole("button", { name: `Search ${CTF_OPS.name}` }));
    expect(useAppStore.getState().searchOpen).toBe(true);
  });

  it("asks for a nick before inviting, and closes on Escape", () => {
    render(<ChannelHeader />);
    const invite = screen.getByRole("button", { name: "Invite" });
    expect(screen.queryByLabelText(/Nick to invite/)).toBeNull();

    fireEvent.click(invite);
    const field = screen.getByLabelText(`Nick to invite to ${CTF_OPS.name}`);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByLabelText(/Nick to invite/)).toBeNull();
  });
});
