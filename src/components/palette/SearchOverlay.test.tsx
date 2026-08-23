import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { activeTarget, makeChannel, makeNetwork, makeQuery, oneView } from "@/components/shell/fixtures";
import type { ChatMessage, SearchHit } from "@/types";
import { SearchOverlay, searchAfter, snippetSegments } from "./SearchOverlay";

const searchHistory = vi.fn();
const loadHistoryAround = vi.fn();
const listBookmarks = vi.fn();
const setBookmarkNote = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    searchHistory: (req: unknown) => searchHistory(req),
    loadHistoryAround: (...args: unknown[]) => loadHistoryAround(...args),
    listBookmarks: (...args: unknown[]) => listBookmarks(...args),
    setBookmarkNote: (...args: unknown[]) => setBookmarkNote(...args),
  },
}));

function message(id: string, text: string): ChatMessage {
  return {
    id,
    idIsLocal: false,
  via: null,
    network: "libera",
    target: "#ctf-ops",
    kind: "privmsg",
    sender: { nick: "sable", user: null, host: null, account: null, isSelf: false },
    timestamp: "2026-07-29T02:41:00Z",
    timestampIsLocal: false,
    text,
    tags: [],
    replyTo: null,
    batch: null,
    delivery: { state: "delivered" },
    attachments: [],
    encryption: "plaintext",
    raw: "",
    source: "localArchive",
  };
}

const hits: SearchHit[] = [
  {
    message: message("1", "got the LFI on the template loader"),
    snippet: "got the <mark>LFI</mark> on the template loader",
    note: null,
  },
  {
    message: message("2", "the LFI needs double encoding"),
    snippet: "the <mark>LFI</mark> needs <mark>double</mark> encoding",
    note: "Try the proxy logs",
  },
];

beforeEach(() => {
  localStorage.clear();
  searchHistory.mockReset();
  searchHistory.mockResolvedValue(hits);
  loadHistoryAround.mockReset();
  loadHistoryAround.mockResolvedValue(hits.map((hit) => hit.message));
  listBookmarks.mockReset();
  listBookmarks.mockResolvedValue(hits);
  setBookmarkNote.mockReset();
  setBookmarkNote.mockResolvedValue(undefined);
  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
    searchOpen: true,
    searchMode: "search",
  });
});

function type(text: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: text } });
}

describe("SearchOverlay", () => {
  it("renders nothing while the store says it is closed", () => {
    useAppStore.setState({ searchOpen: false });
    const { container } = render(<SearchOverlay />);
    expect(container.innerHTML).toBe("");
  });

  it("waits for a query worth sending", () => {
    render(<SearchOverlay />);
    type("");
    expect(searchHistory).not.toHaveBeenCalled();
    expect(screen.getByText(/search this conversation/i)).toBeTruthy();
  });

  /** The floor was two of `String.length`, which counts UTF-16 code units: a
   * surrogate pair passed it and a kanji did not. Both are one character and
   * both are a real query now the archive can answer them. #378. */
  it.each(["落", "🔥", "_"])("sends a one-character query: %s", async (query) => {
    render(<SearchOverlay />);
    type(query);

    await waitFor(() =>
      expect(searchHistory).toHaveBeenCalledWith({
        query,
        network: "libera",
        target: "#ctf-ops",
        sender: null,
        after: null,
        limit: 50,
      }),
    );
  });

  it("searches the active target", async () => {
    render(<SearchOverlay />);
    type("lfi");

    await waitFor(() =>
      expect(searchHistory).toHaveBeenCalledWith({
        query: "lfi",
        network: "libera",
        target: "#ctf-ops",
        sender: null,
        after: null,
        limit: 50,
      }),
    );
  });

  it("saves, reruns, and removes a query", async () => {
    render(<SearchOverlay />);
    type("deployment");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(localStorage.getItem("ircx.search.saved")).toBe('["deployment"]');

    type("");
    fireEvent.click(screen.getByRole("button", { name: "deployment" }));
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "deployment");
    await waitFor(() => expect(searchHistory).toHaveBeenLastCalledWith({
      query: "deployment",
      network: "libera",
      target: "#ctf-ops",
      sender: null,
      after: null,
      limit: 50,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Remove saved search deployment" }));
    expect(screen.queryByRole("button", { name: "deployment" })).toBeNull();
  });

  it("narrows a search by sender and age", async () => {
    render(<SearchOverlay />);
    type("deploy");
    fireEvent.change(screen.getByLabelText("Search sender"), { target: { value: "sable" } });
    fireEvent.change(screen.getByLabelText("Search age"), { target: { value: "week" } });

    await waitFor(() => expect(searchHistory).toHaveBeenLastCalledWith({
      query: "deploy",
      network: "libera",
      target: "#ctf-ops",
      sender: "sable",
      after: expect.any(String),
      limit: 50,
    }));
  });

  it("lists bookmarks for the active target", async () => {
    render(<SearchOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "bookmarks" }));
    await waitFor(() => expect(listBookmarks).toHaveBeenCalledWith("libera", "#ctf-ops", 50));
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Try the proxy logs")).toBeTruthy();
  });

  it("adds a note without opening the message", async () => {
    render(<SearchOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "bookmarks" }));
    await screen.findAllByRole("listitem");

    fireEvent.click(screen.getAllByRole("button", { name: "Add note" })[0]!);
    fireEvent.change(screen.getByLabelText("Bookmark note"), {
      target: { value: "  Recheck after deploy  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(setBookmarkNote).toHaveBeenCalledWith(
        "libera",
        "#ctf-ops",
        "1",
        "Recheck after deploy",
      ),
    );
    expect(screen.getByText("Recheck after deploy")).toBeTruthy();
    expect(loadHistoryAround).not.toHaveBeenCalled();
  });

  it("lists unread highlights and direct messages across networks", () => {
    const channelKey = targetKey("libera", "#ctf-ops");
    const queryKey = targetKey("oftc", "phrack");
    const ordinary = { ...message("ordinary", "status is green"), target: "#ctf-ops" };
    const highlight = { ...message("highlight", "sable: deploy failed"), target: "#ctf-ops" };
    const raised = {
      ...message("raised", "the canary failed"),
      target: "#ctf-ops",
      timestamp: "2026-07-29T02:43:00Z",
      raisedBy: ["deploys"],
    };
    const direct = {
      ...message("direct", "can you check the build?"),
      network: "oftc",
      target: "phrack",
      timestamp: "2026-07-29T02:42:00Z",
    };
    useAppStore.setState({
      networks: {
        libera: makeNetwork("libera"),
        oftc: makeNetwork("oftc", { name: "OFTC" }),
      },
      channels: { [channelKey]: makeChannel("libera", "#ctf-ops", { unread: 3, highlights: 2 }) },
      queries: { [queryKey]: makeQuery("oftc", "phrack", { unread: 1 }) },
      members: {},
      timelines: {
        [channelKey]: {
          messages: [ordinary, highlight, raised],
          unreadFrom: "ordinary",
          readMarker: null,
          hasMore: false,
          detachedAt: null,
          loadingOlder: false,
          askedBehind: null,
        },
        [queryKey]: {
          messages: [direct],
          unreadFrom: "direct",
          readMarker: null,
          hasMore: false,
          detachedAt: null,
          loadingOlder: false,
          askedBehind: null,
        },
      },
      highlightWords: [],
      searchMode: "attention",
    });

    render(<SearchOverlay />);

    const labels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain("the canary failed");
    expect(labels[1]).toContain("can you check the build?");
    expect(labels[2]).toContain("sable: deploy failed");
    expect(labels[1]).toContain("OFTC");
    expect(screen.queryByText("status is green")).toBeNull();
    expect(searchHistory).not.toHaveBeenCalled();
  });

  it("renders the backend's mark spans as highlights", async () => {
    const { container } = render(<SearchOverlay />);
    type("lfi");

    await screen.findByText(/got the/);

    const marks = Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["LFI", "LFI", "double"]);
    expect(screen.getByText(/got the/)).toBeTruthy();
  });

  it("moves through hits and jumps to the exact message chosen", async () => {
    render(<SearchOverlay />);
    type("lfi");
    await screen.findByText(/got the/);

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(
      screen
        .getByRole("listbox", { name: "Search results" })
        .querySelector('[role="option"][aria-selected="true"]')?.textContent,
    ).toContain("double");

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });

    await waitFor(() => expect(useAppStore.getState().searchOpen).toBe(false));
    expect(loadHistoryAround).toHaveBeenCalledWith("libera", "#ctf-ops", "2", 200);
    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    const view = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().messageJump[view]).toBe("2");
  });

  it("closes on Escape", () => {
    render(<SearchOverlay />);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(useAppStore.getState().searchOpen).toBe(false);
  });

  it("shows the reason a search failed", async () => {
    searchHistory.mockRejectedValue("No history is stored for #ctf-ops");
    render(<SearchOverlay />);
    type("lfi");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "No history is stored for #ctf-ops",
    );
  });
});

describe("snippetSegments", () => {
  it("splits marked runs from plain text", () => {
    expect(snippetSegments("got the <mark>LFI</mark> on")).toEqual([
      { text: "got the ", mark: false },
      { text: "LFI", mark: true },
      { text: " on", mark: false },
    ]);
  });

  it("handles a snippet that opens with a mark", () => {
    expect(snippetSegments("<mark>LFI</mark> only")).toEqual([
      { text: "LFI", mark: true },
      { text: " only", mark: false },
    ]);
  });

  it("keeps other angle-bracket text as text", () => {
    // Rendered through React as text, so a snippet carrying markup cannot
    // become markup.
    expect(snippetSegments("try <script>alert(1)</script>")).toEqual([
      { text: "try <script>alert(1)</script>", mark: false },
    ]);
  });
});

describe("searchAfter", () => {
  it("turns age choices into inclusive timestamps", () => {
    const now = Date.parse("2026-08-16T12:00:00Z");
    expect(searchAfter("any", now)).toBeNull();
    expect(searchAfter("day", now)).toBe("2026-08-15T12:00:00.000Z");
    expect(searchAfter("week", now)).toBe("2026-08-09T12:00:00.000Z");
    expect(searchAfter("month", now)).toBe("2026-07-17T12:00:00.000Z");
  });
});
