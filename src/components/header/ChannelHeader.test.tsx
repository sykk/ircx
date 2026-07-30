import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { CTF_OPS, LIBERA } from "@/components/drawer/fixtures";
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
    active: { network: "libera", target: CTF_OPS.name },
    drawerOpen: false,
    searchOpen: false,
  });
});

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
}

describe("ChannelHeader", () => {
  it("renders nothing when no channel is active", () => {
    useAppStore.setState({ active: null });
    const { container } = render(<ChannelHeader />);
    expect(container.firstChild).toBeNull();
  });

  it("names the channel and counts its members, and leaves the topic out", () => {
    render(<ChannelHeader />);
    expect(screen.getByRole("heading", { name: CTF_OPS.name })).toBeTruthy();
    expect(screen.getByText("16 members")).toBeTruthy();
    expect(screen.queryByText(TOPIC)).toBeNull();
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

  it("keeps invite in the overflow menu, and asks for a nick", () => {
    render(<ChannelHeader />);
    expect(screen.queryByRole("menuitem", { name: "Invite" })).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite" }));
    expect(screen.getByLabelText(`Nick to invite to ${CTF_OPS.name}`)).toBeTruthy();
  });

  it("closes the overflow menu on Escape", () => {
    render(<ChannelHeader />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite" }));

    const field = screen.getByLabelText(`Nick to invite to ${CTF_OPS.name}`);
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByLabelText(/Nick to invite/)).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
