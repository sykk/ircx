import { useCallback, useEffect, useState } from "react";
import { plainText } from "@/components/timeline/Markdown";
import { REACTION_EMOJIS } from "@/lib/emojis";
import { ipc, openExternal } from "@/lib/ipc";
import { findMessageById, serverMsgid, useAppStore } from "@/store";
import type { ContextMenuItem, ContextMenuState } from "./ContextMenu";
import { ContextMenu } from "./ContextMenu";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may be unavailable in tests or locked-down webviews.
  }
}

function setFieldValue(
  field: HTMLTextAreaElement | HTMLInputElement,
  value: string,
  caret: number,
) {
  const proto =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(field, value);
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

function nearestRow(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-ui='message-row']");
}

function nearestLink(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest("[data-link-url]");
  return link instanceof HTMLButtonElement ? link : null;
}

function editableField(target: EventTarget | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (!(target instanceof Element)) return null;
  const field = target.closest("textarea, input[type='text'], input:not([type])");
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) return field;
  return null;
}

function buildItems(event: MouseEvent): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const selection = selectedText();

  const field = editableField(event.target);
  if (field) {
    const hasSelection = field.selectionStart !== field.selectionEnd;
    if (hasSelection) {
      items.push({
        kind: "action",
        label: "Cut",
        onClick: () => {
          const start = field.selectionStart ?? 0;
          const end = field.selectionEnd ?? start;
          const text = field.value.slice(start, end);
          void copyText(text).then(() => {
            setFieldValue(field, field.value.slice(0, start) + field.value.slice(end), start);
          });
        },
      });
      items.push({
        kind: "action",
        label: "Copy",
        onClick: () => {
          const start = field.selectionStart ?? 0;
          const end = field.selectionEnd ?? start;
          void copyText(field.value.slice(start, end));
        },
      });
    } else {
      items.push({
        kind: "action",
        label: "Paste",
        onClick: () => {
          void navigator.clipboard.readText().then((text) => {
            if (text === "") return;
            const start = field.selectionStart ?? field.value.length;
            const end = field.selectionEnd ?? start;
            setFieldValue(
              field,
              field.value.slice(0, start) + text + field.value.slice(end),
              start + text.length,
            );
          });
        },
      });
    }
    items.push({
      kind: "action",
      label: "Select all",
      onClick: () => field.select(),
    });
    return items;
  }

  const link = nearestLink(event.target);
  if (link) {
    const url = link.dataset.linkUrl ?? "";
    if (url !== "") {
      items.push({ kind: "action", label: "Open link", onClick: () => void openExternal(url) });
      items.push({ kind: "action", label: "Copy link", onClick: () => void copyText(url) });
    }
    if (selection !== "") {
      items.push({ kind: "separator" });
      items.push({ kind: "action", label: "Copy", onClick: () => void copyText(selection) });
    }
    return items;
  }

  const row = nearestRow(event.target);
  if (row) {
    const id = row.dataset.msgid;
    const message = id ? findMessageById(id) : undefined;
    if (message) {
      const text = plainText(message.text);
      items.push({ kind: "action", label: "Copy message", onClick: () => void copyText(text) });

      const network = useAppStore.getState().networks[message.network];
      const canTag = network?.capsEnabled.includes("message-tags") ?? false;
      const msgid = canTag ? serverMsgid(message) : null;

      if (msgid !== null) {
        items.push({
          kind: "action",
          label: "Reply",
          onClick: () => useAppStore.getState().setReplyTo(message.network, message.target, msgid),
        });
        for (const emoji of REACTION_EMOJIS.slice(0, 6)) {
          items.push({
            kind: "action",
            label: `React ${emoji}`,
            onClick: () =>
              void ipc.react(message.network, message.target, msgid, emoji, true).catch(() => undefined),
          });
        }
      }

      if (selection !== "" && selection !== text) {
        items.push({ kind: "separator" });
        items.push({ kind: "action", label: "Copy selection", onClick: () => void copyText(selection) });
      }
      return items;
    }
  }

  if (selection !== "") {
    items.push({ kind: "action", label: "Copy", onClick: () => void copyText(selection) });
    return items;
  }

  return items;
}

/** Replaces the webview context menu with one that fits a desktop client. */
export function AppContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const items = buildItems(event);
      if (items.length === 0) {
        close();
        return;
      }
      setMenu({ x: event.clientX, y: event.clientY, items });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [close]);

  if (!menu) return null;
  return <ContextMenu menu={menu} onClose={close} />;
}

export { buildItems as buildContextMenuItems };
