import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { LIBERA } from "@/components/drawer/fixtures";
import { TEST_VIEW, oneView } from "@/components/shell/fixtures";
import { makeMessage } from "@/components/timeline/fixtures";
import type { Query } from "@/types";
import { QueryHeader } from "./QueryHeader";

const { ipcMock, sendFileToMock } = vi.hoisted(() => ({
  ipcMock: { submitInput: vi.fn() },
  sendFileToMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@/lib/transfers", () => ({ sendFileTo: sendFileToMock }));

const PHRACK: Query = {
  network: "libera",
  nick: "phrack",
  account: null,
  unread: 0,
  online: true,
  muted: false,
};

function withQuery(query: Partial<Query> = {}, ignored: string[] = []) {
  useAppStore.setState({
    networks: { libera: LIBERA },
    networkOrder: ["libera"],
    queries: { [targetKey("libera", "phrack")]: { ...PHRACK, ...query } },
    ignored: { libera: ignored },
    ...oneView({ network: "libera", target: "phrack" }),
    setup: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.submitInput.mockResolvedValue({ kind: "handled" });
  sendFileToMock.mockResolvedValue(undefined);
  withQuery();
});

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
}

describe("QueryHeader", () => {
  it("draws nothing for a pane that is not on a query", () => {
    useAppStore.setState({ queries: {} });
    const { container } = render(<QueryHeader view={TEST_VIEW} />);
    expect(container.firstChild).toBeNull();
  });

  /** The gap this closes: with no header the only thing naming the pane was
   * the composer's placeholder, which goes as soon as anybody types. */
  it("names the person the conversation is with", () => {
    render(<QueryHeader view={TEST_VIEW} />);
    expect(screen.getByRole("heading", { name: "phrack" })).toBeTruthy();
  });

  it("says they are there", () => {
    render(<QueryHeader view={TEST_VIEW} />);
    expect(screen.getByText("online")).toBeTruthy();
  });

  /** Meaning what it means in the sidebar: not heard from since a quit was
   * seen, rather than known to be away. */
  it("says when they are not", () => {
    withQuery({ online: false });
    render(<QueryHeader view={TEST_VIEW} />);
    expect(screen.getByText("offline")).toBeTruthy();
  });

  /** A room's controls are about a room. A conversation with one person has no
   * members to list, no topic and nobody to invite. */
  it("offers none of the controls that are about a channel", () => {
    render(<QueryHeader view={TEST_VIEW} />);
    expect(screen.queryByRole("button", { name: "Toggle member list" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Catch up" })).toBeNull();
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Invite" })).toBeNull();
  });

  it("clears the conversation it is the header of", () => {
    useAppStore.setState({
      timelines: {
        [targetKey("libera", "phrack")]: {
          messages: [makeMessage({ id: "said", target: "phrack" })],
          unreadFrom: null,
          readMarker: null,
          hasMore: true,
          loadingOlder: false,
          askedBehind: null,
          detachedAt: null,
        },
      },
    });
    render(<QueryHeader view={TEST_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear phrack buffer" }));
    expect(
      useAppStore.getState().timelines[targetKey("libera", "phrack")]?.messages,
    ).toEqual([]);
  });

  /** Whois and ignoring reach a person through the member list everywhere
   * else, and a query has no member list. */
  it("reaches the person through the actions a query has no other way to", async () => {
    render(<QueryHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Whois" }));
    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", "phrack", "/whois phrack"),
    );

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Ignore" }));
    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", "phrack", "/ignore phrack"),
    );
  });

  it("offers to stop ignoring somebody who is ignored", async () => {
    withQuery({}, ["PHRACK"]);
    render(<QueryHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop ignoring" }));
    await waitFor(() =>
      expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", "phrack", "/unignore phrack"),
    );
  });

  it("offers a file to the person it names", async () => {
    render(<QueryHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a file…" }));
    await waitFor(() => expect(sendFileToMock).toHaveBeenCalledWith("libera", "phrack"));
  });

  it("says why a command was refused", async () => {
    ipcMock.submitInput.mockResolvedValue({ kind: "rejected", value: "not connected to Libera" });
    render(<QueryHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Whois" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "not connected to Libera",
    );
  });

  it("opens this network's settings", () => {
    render(<QueryHeader view={TEST_VIEW} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Libera.Chat settings" }));
    expect(useAppStore.getState().setup).not.toBeNull();
  });
});
