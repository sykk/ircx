import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { oneView } from "@/components/shell/fixtures";
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
    ...oneView({ network: "libera", target: CTF_OPS.name }),
    drawerOpen: true,
  });
});

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

  it("shows the member list and nothing else", () => {
    render(<Drawer />);
    expect(screen.getByRole("heading", { name: /operators/i })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("opens the inspector for the member that was clicked, and comes back", () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole("button", { name: /marrow/ }));
    expect(screen.getByRole("heading", { name: "marrow" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Members/ }));
    expect(screen.getByRole("heading", { name: /operators/i })).toBeTruthy();
  });

  it("records the open inspector on the view, not in the drawer", () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole("button", { name: /marrow/ }));

    const { views, activeViewId } = useAppStore.getState();
    expect(views[activeViewId!]!.selectedUser).toBe("marrow");
  });

  it("closes the inspector on Escape before closing itself", () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole("button", { name: /marrow/ }));
    const panel = screen.getByRole("complementary");

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.getByRole("heading", { name: /operators/i })).toBeTruthy();
    expect(useAppStore.getState().drawerOpen).toBe(true);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(useAppStore.getState().drawerOpen).toBe(false);
  });
});
