import { useRef } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { DEFAULT_BINDINGS, displayChord, type Binding } from "@/lib/keybindings";
import { useAppStore } from "@/store";

const GROUPS: readonly { label: string; actions: readonly string[] }[] = [
  {
    label: "General",
    actions: ["palette.toggle", "search.open", "settings.open", "overlay.dismiss"],
  },
  {
    label: "Conversation",
    actions: [
      "roster.toggle",
      "timeline.nickEveryLine",
      "timeline.unread",
      "timeline.nextMention",
      "timeline.latest",
    ],
  },
  {
    label: "Panes",
    actions: [
      "pane.splitVertical",
      "pane.splitHorizontal",
      "pane.close",
      "pane.previous",
      "pane.next",
    ],
  },
  {
    label: "Navigation",
    actions: [
      "target.previousUnread",
      "target.nextUnread",
      "target.jump",
      "history.back",
      "history.forward",
    ],
  },
];

export function ShortcutReference() {
  const open = useAppStore((state) => state.shortcutsOpen);
  return open ? <Dialog /> : null;
}

function Dialog() {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useAppStore((state) => state.closeShortcuts);
  useDialogFocus(dialog);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onMouseDown={close}>
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-reference-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        className="relative flex max-h-[80vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]"
      >
        <header className="flex items-center border-b border-[var(--border-subtle)] px-5 py-4">
          <h2 id="shortcut-reference-title" className="text-base font-semibold text-[var(--text-primary)]">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded-[var(--radius-sm)] px-2 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            Close
          </button>
        </header>

        <div className="grid overflow-y-auto p-5 sm:grid-cols-2 sm:gap-x-8">
          {GROUPS.map((group) => (
            <section key={group.label} className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                {group.label}
              </h3>
              <dl>
                {bindingsFor(group.actions).map((binding) => (
                  <div
                    key={`${binding.action}:${binding.arg ?? ""}`}
                    className="flex min-h-9 items-center gap-4 border-t border-[var(--border-subtle)] py-2 first:border-t-0"
                  >
                    <dt className="min-w-0 flex-1 text-sm text-[var(--text-secondary)]">
                      {binding.description}
                    </dt>
                    <dd>
                      <kbd className="whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-2 py-1 font-mono text-xs text-[var(--badge-text)]">
                        {displayChord(binding.chord)}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function bindingsFor(actions: readonly string[]): Binding[] {
  return DEFAULT_BINDINGS.filter((binding) => actions.includes(binding.action));
}
