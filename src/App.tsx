import { useCallback, useEffect, useState } from "react";
import { NetworkSetup } from "@/components/onboarding/NetworkSetup";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { CommandPalette, SearchOverlay } from "@/components/palette";
import { PaneTree } from "@/components/panes/PaneTree";
import { PluginSheet } from "@/components/plugins";
import { AppShell } from "@/components/shell/AppShell";
import { useAppHotkeys } from "@/hooks/useHotkeys";
import { startBridge } from "@/lib/bridge";
import { loadPlugins } from "@/lib/plugins";
import { startThemes } from "@/lib/theme";
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
    const bridge = startBridge();
    void loadPlugins();
    bridge.then(
      () =>
        setStartup(
          useAppStore.getState().networkOrder.length === 0 ? "onboarding" : "ready",
        ),
      (reason: unknown) => {
        console.error("ircx could not reach its backend", reason);
        setStartup("ready");
      },
    );
    return () => {
      void bridge.then((stop) => stop()).catch(() => {});
      void themes.then((stop) => stop());
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
      <PluginSheet />
    </>
  );
}
