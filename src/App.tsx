import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { CommandPalette, SearchOverlay, ShortcutReference } from "@/components/palette";
import { PaneTree } from "@/components/panes/PaneTree";
import { ChannelList } from "@/components/channels";
import { DropToUpload } from "@/components/uploads/DropToUpload";
import { AppShell } from "@/components/shell/AppShell";
import { StartupFailure } from "@/components/shell/StartupFailure";
import { WindowFrame } from "@/components/shell/WindowFrame";
import { AppContextMenu } from "@/components/common/AppContextMenu";
import { loadViewState } from "@/components/shell/viewState";
import { useAppHotkeys } from "@/hooks/useHotkeys";
import { startBridge } from "@/lib/bridge";
import { reasonOr } from "@/lib/ipc";
import { openFirstConversation } from "@/lib/firstPane";
import { loadHighlightWords, loadHushedNicks } from "@/lib/highlights";
import { openIrcLink, startIrcLinks } from "@/lib/ircLinks";
import { startNotifications } from "@/lib/notifications";
import { startNotificationRouting } from "@/lib/notificationRouting";
import { loadPlugins } from "@/lib/plugins";
import { startThemes } from "@/lib/theme";
import { useAppStore } from "@/store";

/** Onboarding is decided once, when the snapshot lands: saving the first
 * network puts it in the store, and that must not pull the flow out from under
 * the connection it just started.
 */
type Startup = "loading" | "onboarding" | "ready";

const SettingsOverlay = lazy(() =>
  import("@/components/settings").then(({ SettingsOverlay }) => ({ default: SettingsOverlay })),
);

export function App() {
  useAppHotkeys();
  const [startup, setStartup] = useState<Startup>("loading");
  /** Bumped by Try again, which re-runs the effect below — and its cleanup
   * first, so nothing it started is left behind by the attempt that failed. */
  const [attempt, setAttempt] = useState(0);
  const settingsOpen = useAppStore((state) => state.settings !== null);
  /** Why the window could not read its own data, or null. In the store rather
   * than here because the sidebar has to know too: while this is set it must
   * not say there are no networks configured. */
  const failure = useAppStore((state) => state.startupFailure);
  const setStartupFailure = useAppStore((state) => state.setStartupFailure);

  useEffect(() => {
    const themes = startThemes();
    const bridge = startBridge();
    const links = bridge.then(() => startIrcLinks(openIrcLink));
    let stopOpening = () => {};
    // The timeline tints a line against these; the Notifications page writes
    // them and re-reads them in the same call.
    void loadHighlightWords();
    void loadHushedNicks();
    // Follows whether the window has focus, which is what keeps a notification
    // from arriving for the line somebody just watched appear.
    const notifications = startNotifications();
    const notificationRoutes = startNotificationRouting();
    void loadPlugins();
    bridge.then(
      () => {
        const state = useAppStore.getState();
        if (state.networkOrder.length === 0) {
          setStartup("onboarding");
        } else {
          // After the snapshot rather than on mount: which panes can come back
          // is a question about which conversations are still open, and until
          // the snapshot lands the answer is none of them.
          const stored = loadViewState()?.layout;
          if (stored) state.restoreLayout(stored);
          setStartup("ready");
        }
        // Both paths, and after the restore has had the window: what the last
        // run left outranks a conversation that merely exists. A first launch
        // goes through onboarding and has none of either yet, which is the
        // case this waits for.
        stopOpening = openFirstConversation();
      },
      (reason: unknown) => {
        console.error("ircx could not reach its backend", reason);
        useAppStore
          .getState()
          .setStartupFailure(reasonOr(reason, "The reason was not one ircx could read."));
        setStartup("ready");
      },
    );
    return () => {
      stopOpening();
      void bridge.then((stop) => stop()).catch(() => {});
      void links.then((stop) => stop()).catch(() => {});
      void themes.then((stop) => stop());
      void notifications.then((stop) => stop());
      void notificationRoutes.then((stop) => stop());
    };
  }, [attempt]);

  const finish = useCallback(() => setStartup("ready"), []);
  const retry = useCallback(() => {
    setStartupFailure(null);
    setStartup("loading");
    setAttempt((n) => n + 1);
  }, [setStartupFailure]);

  return (
    <>
      <AppShell>
        {failure !== null ? (
          <StartupFailure reason={failure} onRetry={retry} />
        ) : startup === "onboarding" ? (
          <Onboarding onDone={finish} />
        ) : (
          <PaneTree />
        )}
      </AppShell>

      {/* Before the palette and the search, which are reachable by chord while
          it is open and share its stacking level — later in the tree paints on
          top, and a palette drawn under the settings dialog is a palette
          nobody can read. */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsOverlay />
        </Suspense>
      )}
      <CommandPalette />
      <ShortcutReference />
      <SearchOverlay />
      <DropToUpload />
      <ChannelList />

      {/* Last, so the four pixels at the window's edge outrank whatever sheet
          is over the rest of it: a window stays resizable while it is busy. */}
      <WindowFrame />
      <AppContextMenu />
    </>
  );
}
