import { useAppStore } from "@/store";
import type { ViewId } from "@/store/types";
import { AppearancePage } from "./appearance/AppearancePage";
import { PluginsPage } from "./plugins/PluginsPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { PrivacyPage } from "./privacy/PrivacyPage";
import { UploadsPage } from "./uploads/UploadsPage";
import { SettingsBusy } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";
import { useSettingsScope } from "./scope";

/**
 * Everything in `sections.ts`, in a pane of the client's own layout.
 *
 * A pane rather than a window or a sheet, and the Appearance page is the whole
 * argument: every control on it changes how a conversation reads, and a sheet
 * puts a scrim over the only evidence that can be judged against. Split beside
 * a channel, these settings are judged against the reader's own conversation,
 * at their own density, in their own theme — which is better evidence than the
 * sample `previewChannel.ts` scripts, and the sample is still there for a
 * first run that has no conversation yet.
 *
 * It is in the window that holds the conversations, so it reads what it needs
 * out of the store: the scope its pages are scoped to, and the section its own
 * sidebar is on. Nothing is announced anywhere, because there is nobody else
 * to tell.
 */
export function SettingsPane({ view }: { view: ViewId | null }) {
  return (
    <SettingsBusy>
      <Pane view={view} />
    </SettingsBusy>
  );
}

function Pane({ view }: { view: ViewId | null }) {
  const section = useAppStore((s) => s.settings?.section ?? null);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const closeView = useAppStore((s) => s.closeView);
  const scope = useSettingsScope();

  /* The store's record is where the section lives, and this is the narrowing
   * for it. Unreachable: the pane and the record are written together, so a
   * pane drawn at all has one. */
  if (section === null) return null;

  const done = () => {
    if (view) closeView(view);
  };

  return (
    <div
      className="grid min-h-0 min-w-0 flex-1"
      style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}
      data-ui="settings"
    >
      <SettingsSidebar section={section} onChoose={setSettingsSection} />

      <main
        role="tabpanel"
        id={`settings-panel-${section}`}
        aria-labelledby={`settings-tab-${section}`}
        tabIndex={-1}
        className="min-w-0 overflow-y-auto"
      >
        {section === "appearance" && <AppearancePage onDone={done} />}
        {section === "notifications" && <NotificationsPage here={scope} onDone={done} />}
        {section === "uploads" && <UploadsPage onDone={done} />}
        {section === "privacy" && <PrivacyPage here={scope} onDone={done} />}
        {section === "plugins" && <PluginsPage onDone={done} />}
      </main>
    </div>
  );
}
