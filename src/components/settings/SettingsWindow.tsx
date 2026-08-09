import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowFrame } from "@/components/shell/WindowFrame";
import { insideTauri } from "@/lib/ipc";
import { isTextEntry } from "@/lib/keybindings";
import { startAppearanceSync, startThemes } from "@/lib/theme";
import { AppearancePage } from "./appearance/AppearancePage";
import { SettingsSidebar } from "./SettingsSidebar";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { SECTIONS, type SectionId } from "./sections";

/** Everything in `sections.ts`, in the window that holds it.
 *
 * This window runs no event bridge. What the client's store is mostly made of
 * — the conversations, their members, the messages — is fed by the pump in
 * src/lib/bridge.ts, and none of it is a setting. Reading it here would put a
 * second consumer on the same event stream for no gain and cost a second copy
 * of every timeline. What this window does start is the two things its own
 * pages need: the themes directory, and the other window's appearance. */
export function SettingsWindow() {
  const [section, setSection] = useState<SectionId>(SECTIONS[0]!.id);

  useEffect(() => {
    const themes = startThemes();
    const sync = startAppearanceSync();
    return () => {
      void themes.then((stop) => stop());
      void sync.then((stop) => stop());
    };
  }, []);

  const close = useCallback(() => {
    if (insideTauri()) void getCurrentWindow().close();
  }, []);

  /* On the document rather than on the element below, which is what a sheet
   * would do. A window opens with focus on `document.body`, and body is
   * outside the React root — a handler in the tree would not see the keystroke
   * until something inside had been clicked, so Escape would work only for
   * somebody who did not need it. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Not from inside a field. Escape there is how a value being typed is
      // abandoned — the token editor behind Custom… is full of them — and
      // taking the window with it would be a trap.
      if (event.key !== "Escape" || isTextEntry(event.target)) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div
      className="grid h-full grid-rows-[auto_minmax(0,1fr)] bg-[var(--surface-base)]"
      data-ui="settings"
    >
      <SettingsTitleBar />

      <div className="grid min-h-0" style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}>
        <SettingsSidebar section={section} onChoose={setSection} />

        <main
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={-1}
          className="min-w-0 overflow-y-auto"
        >
          {section === "appearance" && <AppearancePage onDone={close} />}
        </main>
      </div>

      {/* As in the client: four pixels at the window's edge, so an undecorated
          window is still resizable. */}
      <WindowFrame />
    </div>
  );
}
