import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { activeTarget, oneView } from "@/components/shell/fixtures";
import type { ChatMessage, SearchHit } from "@/types";
import { SearchOverlay, snippetSegments } from "./SearchOverlay";

const searchHistory = vi.fn();
const loadHistoryAround = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    searchHistory: (req: unknown) => searchHistory(req),
    loadHistoryAround: (...args: unknown[]) => loadHistoryAround(...args),
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
  },
  {
    message: message("2", "the LFI needs double encoding"),
    snippet: "the <mark>LFI</mark> needs <mark>double</mark> encoding",
  },
];

beforeEach(() => {
  searchHistory.mockReset();
  searchHistory.mockResolvedValue(hits);
  loadHistoryAround.mockReset();
  loadHistoryAround.mockResolvedValue(hits.map((hit) => hit.message));
  useAppStore.setState({
    ...oneView({ network: "libera", target: "#ctf-ops" }),
    searchOpen: true,
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
        limit: 50,
      }),
    );
  });

  it("renders the backend's mark spans as highlights", async () => {
    const { container } = render(<SearchOverlay />);
    type("lfi");

    await screen.findAllByRole("option");

    const marks = Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["LFI", "LFI", "double"]);
    expect(screen.getByText(/got the/)).toBeTruthy();
  });

  it("moves through hits and jumps to the exact message chosen", async () => {
    render(<SearchOverlay />);
    type("lfi");
    await screen.findAllByRole("option");

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("double");

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
