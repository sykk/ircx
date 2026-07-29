import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { Drawer } from "./Drawer";
import { CTF_OPS, CTF_OPS_MEMBERS, LIBERA } from "./fixtures";

const nativeOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
});

afterAll(() => {
  if (nativeOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", nativeOffsetHeight);
  }
});

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    channels: { [targetKey("libera", CTF_OPS.name)]: CTF_OPS },
    members: { [targetKey("libera", CTF_OPS.name)]: CTF_OPS_MEMBERS },
    active: { network: "libera", target: CTF_OPS.name },
    drawerOpen: true,
  });
});

function openTab(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

describe("Drawer", () => {
  it("renders nothing while closed", () => {
    useAppStore.setState({ drawerOpen: false });
    const { container } = render(<Drawer />);
    expect(container.firstChild).toBeNull();
  });

  it("opens and closes on the keyboard shortcut", () => {
    useAppStore.setState({ drawerOpen: false });
    render(<Drawer />);
    fireEvent.keyDown(window, { key: "M", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().drawerOpen).toBe(true);
    fireEvent.keyDown(window, { key: "M", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().drawerOpen).toBe(false);
  });

  it("opens the inspector for the member that was clicked, and comes back", () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole("button", { name: /marrow/ }));
    expect(screen.getByRole("heading", { name: "marrow" })).toBeTruthy();
    expect(screen.queryByLabelText("Filter members")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Members/ }));
    expect(screen.getByLabelText("Filter members")).toBeTruthy();
  });

  it("closes the inspector on Escape before closing itself", () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole("button", { name: /marrow/ }));
    const panel = screen.getByRole("complementary");

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.getByLabelText("Filter members")).toBeTruthy();
    expect(useAppStore.getState().drawerOpen).toBe(true);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(useAppStore.getState().drawerOpen).toBe(false);
  });

  it("shows the topic, who set it, and the modes in plain words", () => {
    render(<Drawer />);
    openTab("Channel info");
    expect(screen.getByText(CTF_OPS.topic!.text)).toBeTruthy();
    expect(screen.getByText(/Set by sable/)).toBeTruthy();
    expect(screen.getByText("no external messages, topic locked by ops")).toBeTruthy();
    expect(screen.getByText("ircs://irc.libera.chat:6697/#ctf-ops")).toBeTruthy();
  });

  it("keeps the notification level per channel", () => {
    const { unmount } = render(<Drawer />);
    openTab("Notifications");
    fireEvent.click(screen.getByRole("radio", { name: /Highlights only/ }));
    unmount();

    render(<Drawer />);
    openTab("Notifications");
    expect(screen.getByRole("radio", { name: /Highlights only/ })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("keeps the retention override per channel", () => {
    const { unmount } = render(<Drawer />);
    openTab("Channel settings");
    fireEvent.change(screen.getByLabelText(/Local history/), {
      target: { value: "30" },
    });
    unmount();

    render(<Drawer />);
    openTab("Channel settings");
    expect(screen.getByLabelText(/Local history/)).toHaveProperty("value", "30");
  });
});
