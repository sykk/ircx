import { useCallback, useEffect, useState } from "react";
import { NetworkSetup } from "@/components/onboarding/NetworkSetup";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { CommandPalette, SearchOverlay } from "@/components/palette";
import { PaneTree } from "@/components/panes/PaneTree";
import { ChannelList } from "@/components/channels";
import { DropToUpload } from "@/components/uploads/DropToUpload";
import { AppShell } from "@/components/shell/AppShell";
import { WindowFrame } from "@/components/shell/WindowFrame";
import { AppContextMenu } from "@/components/common/AppContextMenu";
import { loadViewState } from "@/components/shell/viewState";
import { useAppHotkeys } from "@/hooks/useHotkeys";
import { startBridge } from "@/lib/bridge";
import { openFirstConversation } from "@/lib/firstPane";
import { loadPlugins, startPluginSync } from "@/lib/plugins";
import { startAppearanceSync, startThemes } from "@/lib/theme";
import { useAppStore } from "@/store";

/** Onboarding is decided once, when the snapshot lands: saving the first
 * network puts it in the store, and that must not pull the flow out from under
 * the connection it just started. */
type Startup = "loading" | "onboarding" | "ready";

export function App() {
  useAppHotkeys();
  const [startup, setStartup] = useState<Startup>("loading");

  useEffect(() => {
    const themes = startThemes();
    // The settings window is where these are changed, and it is a second
    // webview: without this the client keeps painting whatever it opened on
    // while the settings window shows the change it made.
    const appearance = startAppearanceSync();
    const bridge = startBridge();
    let stopOpening = () => {};
    void loadPlugins();
    // The plugin screens are in the settings window now; the count in the
    // status bar is here, and nothing else would tell it an install happened.
    const pluginSync = startPluginSync();
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
        setStartup("ready");
      },
    );
    return () => {
      stopOpening();
      void bridge.then((stop) => stop()).catch(() => {});
      void themes.then((stop) => stop());
      void appearance.then((stop) => stop());
      void pluginSync.then((stop) => stop());
    };
  }, []);

  const finish = useCallback(() => setStartup("ready"), []);

  return (
    <>
      <AppShell>
        {startup === "onboarding" ? <Onboarding onDone={finish} /> : <PaneTree />}
      </AppShell>

      <CommandPalette />
      <SearchOverlay />
      <NetworkSetup />
      <DropToUpload />
      <ChannelList />

      {/* Last, so the four pixels at the window's edge outrank whatever sheet
          is over the rest of it: a window stays resizable while it is busy. */}
      <WindowFrame />
      <AppContextMenu />
    </>
  );
}
