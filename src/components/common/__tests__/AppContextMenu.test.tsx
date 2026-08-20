import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildContextMenuItems } from "@/components/common/AppContextMenu";
import { makeNetwork } from "@/components/shell/fixtures";
import { makeMessage } from "@/components/timeline/fixtures";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { ContextMenuItem } from "@/components/common/ContextMenu";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    react: vi.fn().mockResolvedValue(undefined),
  },
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

const clipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue("pasted"),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard });
});

function labels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => (item.kind === "action" ? [item.label] : []));
}

function menuEvent(target: EventTarget): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 200,
  });
  Object.defineProperty(event, "target", { value: target, enumerable: true });
  return event;
}

describe("buildContextMenuItems", () => {
  it("offers copy when text is selected", () => {
    document.body.innerHTML = `<p class="selectable">hello world</p>`;
    const node = document.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const items = buildContextMenuItems(menuEvent(node));
    expect(items.some((item) => item.kind === "action" && item.label === "Copy")).toBe(true);
  });

  it("offers edit actions on a textarea", () => {
    document.body.innerHTML = `<textarea>typed</textarea>`;
    const field = document.querySelector("textarea")!;
    field.focus();
    field.setSelectionRange(0, field.value.length);

    expect(labels(buildContextMenuItems(menuEvent(field)))).toEqual(["Cut", "Copy", "Select all"]);
  });

  it("offers message actions on a timeline row", () => {
    const message = makeMessage({ id: "msg-42", text: "flag in **env**" });
    const key = targetKey("libera", "#ctf-ops");
    useAppStore.setState({
      timelines: {
        [key]: {
          messages: [message],
          hasMore: false,
          loadingOlder: false,
          unreadFrom: null, readMarker: null,
          askedBehind: null,
        },
      },
      networks: {
        libera: makeNetwork("libera", { capsEnabled: ["message-tags"] }),
      },
    });

    document.body.innerHTML = `<div data-ui="message-row" data-msgid="msg-42"></div>`;
    const row = document.querySelector("[data-ui='message-row']")!;

    const menuLabels = labels(buildContextMenuItems(menuEvent(row)));
    expect(menuLabels[0]).toBe("Copy message");
    expect(menuLabels).toContain("Reply");
    expect(menuLabels.some((label) => label.startsWith("React "))).toBe(true);
  });

  it("offers link actions on a marked URL button", () => {
    document.body.innerHTML = `<button type="button" data-link-url="https://example.com">host</button>`;
    const link = document.querySelector("button")!;

    expect(labels(buildContextMenuItems(menuEvent(link)))).toEqual(["Open link", "Copy link"]);
  });

  it("returns nothing on empty chrome", () => {
    document.body.innerHTML = `<div data-ui="shell"></div>`;
    expect(buildContextMenuItems(menuEvent(document.querySelector("[data-ui='shell']")!))).toEqual([]);
  });
});
