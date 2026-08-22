import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { ipc } from "@/lib/ipc";
import { activeTarget, makeNetwork, resetStore } from "@/components/shell/fixtures";
import type { ChannelListing } from "@/types";
import { ChannelList } from "./ChannelList";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    joinChannel: vi.fn().mockResolvedValue(undefined),
    submitInput: vi.fn().mockResolvedValue({ kind: "handled" }),
  },
  onIrcxEvent: vi.fn(),
}));

/* The virtualiser sizes itself from the scroll container, which jsdom reports
 * as zero high. Without a height it renders no rows at all. */
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
  resetStore();
  vi.mocked(ipc.submitInput).mockReset().mockResolvedValue({ kind: "handled" });
});

function listing(name: string, users: number, topic = ""): ChannelListing {
  return { name, users, topic };
}

function show(channels: ChannelListing[], truncated = false) {
  useAppStore.setState({
    channelsOpen: "libera",
    channelList: { libera: { channels, truncated } },
  });
  render(<ChannelList />);
}

function rows(): string[] {
  return [...document.querySelectorAll("[data-index]")].map(
    (row) => row.textContent ?? "",
  );
}

describe("the channel list", () => {
  it("stays out of the way until a list arrives", () => {
    const { container } = render(<ChannelList />);
    expect(container.firstChild).toBeNull();
  });

  it("asks the server when the browser opens without a list", () => {
    useAppStore.setState({ channelsOpen: "libera" });
    render(<ChannelList />);

    expect(screen.getByText("Loading channels…")).toBeTruthy();
    expect(ipc.submitInput).toHaveBeenCalledWith("libera", "*", "/list");
  });

  it("shows why the server refused to list channels", async () => {
    vi.mocked(ipc.submitInput).mockResolvedValueOnce({
      kind: "rejected",
      value: "Connect to libera before listing its channels.",
    });
    useAppStore.setState({ channelsOpen: "libera" });
    render(<ChannelList />);

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Connect to libera before listing its channels.",
    );
  });

  it("shows what the server said about each channel", () => {
    show([listing("#ircx", 42, "the topic goes here")]);

    const row = rows()[0] ?? "";
    expect(row).toContain("#ircx");
    expect(row).toContain("42");
    expect(row).toContain("the topic goes here");
  });

  it("filters on the name and on the topic", () => {
    show([
      listing("#ircx", 3, "a client"),
      listing("#rust", 9, "systems programming"),
      listing("#quiet", 0, ""),
    ]);

    fireEvent.change(screen.getByLabelText("Filter"), {
      target: { value: "systems" },
    });
    // The filter is deferred so typing stays responsive; flush it.
    act(() => {});

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("#rust");
  });

  /**
   * #125: Libera answers `/list` with about twenty-two thousand channels. The
   * whole point of this surface is that it is searchable rather than scrolled,
   * and that means it cannot draw them all.
   */
  it("draws what fits rather than everything the server sent", () => {
    const many = Array.from({ length: 22_000 }, (_, n) =>
      listing(`##channel${n}`, n, "a topic"),
    );
    show(many);

    const drawn = rows().length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(200);
  });

  it("says when the server had more than ircx kept", () => {
    show([listing("#ircx", 1)], true);
    expect(screen.getByText(/the server had more than ircx keeps/)).toBeTruthy();
  });

  it("counts what the filter left against what arrived", () => {
    show([listing("#ircx", 1), listing("#rust", 2)]);
    expect(screen.getByText("2 channels")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter"), {
      target: { value: "rust" },
    });
    act(() => {});

    expect(screen.getByText("1 of 2 channels")).toBeTruthy();
  });

  it("closes on Escape, which reaches it because it takes focus", () => {
    show([listing("#ircx", 1)]);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(
      true,
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(useAppStore.getState().channelsOpen).toBeNull();
  });

  it("puts itself away when a channel is chosen", async () => {
    useAppStore.setState({ networks: { libera: makeNetwork("libera") } });
    show([listing("#ircx", 1)]);

    await act(async () => {
      fireEvent.click(screen.getByText("#ircx"));
    });

    expect(useAppStore.getState().channelsOpen).toBeNull();
    expect(activeTarget()).toEqual({ network: "libera", target: "#ircx" });
  });
});
