import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowFrame } from "@/components/shell/WindowFrame";
import { insideTauri, onSettingsSection } from "@/lib/ipc";
import { isTextEntry } from "@/lib/keybindings";
import { loadPlugins, startPluginSync } from "@/lib/plugins";
import { readScope, type SettingsScope } from "@/lib/settingsWindow";
import { startAppearanceSync, startThemes } from "@/lib/theme";
import { AppearancePage } from "./appearance/AppearancePage";
import { PluginsPage } from "./plugins/PluginsPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { PrivacyPage } from "./privacy/PrivacyPage";
import { UploadsPage } from "./uploads/UploadsPage";
import { SettingsBusy, useSettingsBusy } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { isSectionId, type SectionId } from "./sections";
import { openingSection } from ".";

/** Everything in `sections.ts`, in the window that holds it.
 *
 * This window runs no event bridge. What the client's store is mostly made of
 * — the conversations, their members, the messages — is fed by the pump in
 * src/lib/bridge.ts, and none of it is a setting. Reading it here would put a
 * second consumer on the same event stream for no gain and cost a second copy
 * of every timeline. What it starts instead is what its own pages need: the
 * themes directory, the installed plugins, and the client's half of both.
 *
 * The one thing a page here wants that only the client knows is which
 * conversation is on screen, which the Privacy page scopes retention and
 * deletion by. That is handed over rather than subscribed to — see
 * src/lib/settingsWindow.ts. */
export function SettingsWindow() {
  return (
    <SettingsBusy>
      <Window />
    </SettingsBusy>
  );
}

function Window() {
  const [section, setSection] = useState<SectionId>(openingSection);
  /* Read once, when the window comes up, and again whenever the client asks
   * for a section — those are the two moments it was written. A snapshot
   * rather than a subscription: see src/lib/settingsWindow.ts. */
  const [scope, setScope] = useState<SettingsScope | null>(readScope);

  useEffect(() => {
    const themes = startThemes();
    const appearance = startAppearanceSync();
    const plugins = startPluginSync();
    void loadPlugins();

    /* A window already open cannot be re-navigated without throwing away
     * whatever page it is on, so `open_settings` tells it to move instead. */
    const section = onSettingsSection((asked) => {
      setScope(readScope());
      if (isSectionId(asked)) setSection(asked);
    });

    return () => {
      void themes.then((stop) => stop());
      void appearance.then((stop) => stop());
      void plugins.then((stop) => stop());
      void section.then((stop) => stop()).catch(() => {});
    };
  }, []);

  const busy = useSettingsBusy();

  /* Refused while a page has a request in flight, for the reason each of these
   * pages refused it as a sheet: closing loses the answer. The title bar's X
   * and the desktop's own close are not covered and cannot be — but those are
   * deliberate, and Escape is the one pressed by accident. */
  const close = useCallback(() => {
    if (busy) return;
    if (insideTauri()) void getCurrentWindow().close();
  }, [busy]);

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
          {section === "notifications" && <NotificationsPage here={scope} onDone={close} />}
          {section === "uploads" && <UploadsPage onDone={close} />}
          {section === "privacy" && <PrivacyPage here={scope} onDone={close} />}
          {section === "plugins" && <PluginsPage onDone={close} />}
        </main>
      </div>

      {/* As in the client: four pixels at the window's edge, so an undecorated
          window is still resizable. */}
      <WindowFrame />
    </div>
  );
}
