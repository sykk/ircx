import { useRef } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { isTextEntry } from "@/lib/keybindings";
import { useAppStore } from "@/store";
import { AppearancePage } from "./appearance/AppearancePage";
import { PluginsPage } from "./plugins/PluginsPage";
import { NetworksPage } from "./networks/NetworksPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { PrivacyPage } from "./privacy/PrivacyPage";
import { UploadsPage } from "./uploads/UploadsPage";
import { useSettingsScope } from "./scope";
import type { SectionId } from "./sections";
import { SettingsBusy, useSettingsBusy } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";

/**
 * Everything in `sections.ts`, in a dialog over the conversation.
 *
 * **No scrim**, which is the whole of why this shape works where a sheet did
 * not. Every control on the Appearance page changes how a conversation reads,
 * and dimming the window behind is dimming the only evidence any of them can
 * be judged against. So the panel is told apart from the client by its own
 * border and shadow, and what it does not cover stays lit and legible.
 *
 * A dialog rather than a pane of the layout, which is what this was: a pane
 * bought the same undimmed evidence by charging the tree for it — a leaf that
 * was not a conversation, a floor of its own for the divider beside it, and a
 * second answer to "which pane is the reader in" for everything that asks. The
 * conversation still shows around this, and none of that follows.
 *
 * It is modal all the same: `aria-modal` and the focus trap, because the pages
 * behind cannot be worked while their settings are being changed.
 */
export function SettingsOverlay() {
  const section = useAppStore((s) => s.settings);
  if (section === null) return null;
  return (
    <SettingsBusy>
      <Dialog section={section} />
    </SettingsBusy>
  );
}

function Dialog({ section }: { section: SectionId }) {
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const scope = useSettingsScope();
  const busy = useSettingsBusy();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

  /* Every way out, declined while a page has a request in flight: closing
   * loses the answer, so an install lands with its permissions never asked and
   * a failed save reports into a screen that has gone. `Done` is disabled by
   * the same flag and cannot reach this; Escape and a click outside can. */
  const close = () => {
    if (!busy) closeSettings();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onMouseDown={close}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-ui="settings"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          /* Not from inside a field. Escape there is how a value being typed
           * is abandoned — the token editor behind Custom… is full of them —
           * and taking the dialog with it would be a trap. */
          if (event.key !== "Escape" || isTextEntry(event.target)) return;
          event.stopPropagation();
          close();
        }}
        /* Wide enough that the Appearance rail sits beside its preview on the
           window this app opens at, rather than stacking under it: the panel
           is the container that breakpoint is measured against, and 1024 less
           the section list leaves it the 768 it asks for.

           `--surface-overlay` and not the base the pages were drawn on as a
           window: with no scrim under it, a panel painted the same colour as
           the app behind is separated by one pixel of border and a shadow that
           is black on near-black. The overlay surface is the token for a thing
           floating over the client, which is what this is. */
        className="relative grid h-[min(680px,84vh)] w-[min(1024px,92vw)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]"
        style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}
      >
        <SettingsSidebar section={section} onChoose={setSettingsSection} />

        <main
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={-1}
          className="@container min-w-0 overflow-y-auto"
        >
          {section === "appearance" && <AppearancePage onDone={close} />}
          {section === "notifications" && <NotificationsPage here={scope} onDone={close} />}
          {section === "uploads" && <UploadsPage onDone={close} />}
          {section === "privacy" && <PrivacyPage here={scope} onDone={close} />}
          {section === "plugins" && <PluginsPage onDone={close} />}
          {section === "networks" && <NetworksPage onDone={close} />}
        </main>
      </div>
    </div>
  );
}
