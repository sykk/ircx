import { useRef, useState } from "react";
import { selectTheme } from "@/lib/theme";
import { useAppStore } from "@/store";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { ThemeList } from "./ThemeList";
import { TokenEditor } from "./TokenEditor";

/**
 * Everything the window's appearance is made of, in one sheet reached from the
 * command palette: which theme is in force, how tightly the timeline is set,
 * which themes on disk would not load and why, and — one screen in — every
 * token of one theme with the value this person gave it.
 */
export function AppearanceSheet() {
  const open = useAppStore((s) => s.appearanceOpen);
  return open ? <Sheet /> : null;
}

function Sheet() {
  const closeSheet = useAppStore((s) => s.toggleAppearance);
  const themes = useAppStore((s) => s.themes);
  const broken = useAppStore((s) => s.brokenThemes);
  const themeId = useAppStore((s) => s.themeId);
  const density = useAppStore((s) => s.density);
  const presentation = useAppStore((s) => s.presentation);
  const typography = useAppStore((s) => s.typography);

  const [editing, setEditing] = useState<string | null>(null);

  // Nothing in the sheet takes focus on its own — the list is buttons — so
  // without this the keydown below fires from wherever focus was left and
  // Escape never reaches the dialog.
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

  function close() {
    closeSheet(false);
  }

  /* Only the theme in force is painted, edits and all: src/lib/theme/apply.ts
   * merges `overrides[theme.id]` and nothing else, which is what stops one
   * theme's accent landing on another's surfaces. An editor opened on a theme
   * that is not in force would therefore commit values nobody could see, so
   * opening it is also choosing the theme. */
  function edit(id: string) {
    if (id !== themeId) selectTheme(id);
    setEditing(id);
  }

  /* A theme deleted from the directory while its editor is open leaves nothing
   * to edit, and the catalogue is re-read whenever the directory changes. Back
   * to the list rather than a screen with no tokens on it. */
  const editingTheme = themes.find((theme) => theme.id === editing) ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={close}
    >
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Appearance"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}
        className="relative flex max-h-[88vh] w-[min(560px,92vw)] flex-col overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] shadow-[var(--shadow-overlay)]"
      >
        {editingTheme === null ? (
          <ThemeList
            themes={themes}
            broken={broken}
            themeId={themeId}
            density={density}
            presentation={presentation}
            typography={typography}
            onClose={close}
            onEdit={edit}
          />
        ) : (
          <TokenEditor theme={editingTheme} onBack={() => setEditing(null)} />
        )}
      </div>
    </div>
  );
}
