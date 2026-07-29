import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { Channel, Network, Query } from "@/types";
import { CommandPalette } from "./CommandPalette";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));

const network: Network = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  status: { state: "connected" },
  currentNick: "sable",
  sasl: { state: "notConfigured" },
  capsEnabled: [],
  lagMs: null,
};

function channel(name: string, unread = 0): Channel {
  return {
    network: "libera",
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 2,
    unread,
    highlights: 0,
  };
}

function query(nick: string): Query {
  return { network: "libera", nick, account: null, unread: 0, online: true };
}

beforeEach(() => {
  useAppStore.setState({
    networks: { libera: network },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", "#ctf-ops")]: channel("#ctf-ops", 36),
      [targetKey("libera", "#ctf-web")]: channel("#ctf-web"),
      [targetKey("libera", "#capture-the-flag-ops")]: channel("#capture-the-flag-ops"),
      [targetKey("libera", "#linux")]: channel("#linux"),
    },
    queries: { [targetKey("libera", "phrack")]: query("phrack") },
    active: null,
    recent: [],
    paletteOpen: true,
    searchOpen: false,
    drawerOpen: false,
  });
});

function input(): HTMLElement {
  return screen.getByRole("combobox");
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function optionLabels(): string[] {
  return screen.getAllByRole("option").map((el) => el.textContent ?? "");
}

function selectedLabel(): string {
  return screen.getByRole("option", { selected: true }).textContent ?? "";
}

describe("CommandPalette", () => {
  it("renders nothing while the store says it is closed", () => {
    useAppStore.setState({ paletteOpen: false });
    const { container } = render(<CommandPalette />);
    expect(container.innerHTML).toBe("");
  });

  it("lists targets grouped by kind", () => {
    render(<CommandPalette />);
    expect(screen.getByRole("group", { name: "Channels" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Queries" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Commands" })).toBeTruthy();
  });

  it("puts recently visited targets first before anything is typed", () => {
    useAppStore.setState({ recent: [targetKey("libera", "#linux")] });
    render(<CommandPalette />);
    expect(optionLabels()[0]).toContain("#linux");
  });

  it("finds #ctf-ops from ctfo", () => {
    render(<CommandPalette />);
    type("ctfo");
    expect(selectedLabel()).toContain("#ctf-ops");
    expect(optionLabels().some((l) => l.includes("#linux"))).toBe(false);
  });

  it("marks the matched characters in the result", () => {
    const { container } = render(<CommandPalette />);
    type("ctfo");
    const hits = Array.from(container.querySelectorAll("b")).map((b) => b.textContent);
    expect(hits.slice(0, 2)).toEqual(["ctf", "o"]);
  });

  it("moves with the arrow keys and wraps at the ends", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selectedLabel()).not.toBe(first);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selectedLabel()).toBe(first);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selectedLabel()).toBe(optionLabels().at(-1));
  });

  it("moves with Ctrl+N and Ctrl+P", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "n", ctrlKey: true });
    expect(selectedLabel()).not.toBe(first);

    fireEvent.keyDown(input(), { key: "p", ctrlKey: true });
    expect(selectedLabel()).toBe(first);
  });

  it("types a plain n without moving the selection", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "n" });

    expect(selectedLabel()).toBe(first);
  });

  it("opens the selected target on Enter and closes", () => {
    render(<CommandPalette />);
    type("ctfo");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(useAppStore.getState().active).toEqual({ network: "libera", target: "#ctf-ops" });
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("opens a target on click", () => {
    render(<CommandPalette />);
    type("phra");
    fireEvent.click(screen.getAllByRole("option")[0]!);

    expect(useAppStore.getState().active).toEqual({ network: "libera", target: "phrack" });
  });

  it("hands a slash command to the composer", () => {
    const insert = vi.fn();
    render(<CommandPalette onInsertCommand={insert} />);
    type("/join");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(insert).toHaveBeenCalledWith("/join ");
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("runs a settings action", () => {
    render(<CommandPalette />);
    type("member drawer");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(useAppStore.getState().drawerOpen).toBe(true);
  });

  it("closes on Escape without letting it reach the global layer", () => {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    render(<CommandPalette />);

    fireEvent.keyDown(input(), { key: "Escape" });

    document.removeEventListener("keydown", outside);
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(outside).not.toHaveBeenCalled();
  });

  it("says so when nothing matches", () => {
    render(<CommandPalette />);
    type("zzzzq");
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
