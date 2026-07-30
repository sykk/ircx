import { useEffect } from "react";
import { Drawer } from "@/components/drawer/Drawer";
import { CommandPalette, SearchOverlay } from "@/components/palette";
import { PaneTree } from "@/components/panes/PaneTree";
import { AppShell } from "@/components/shell/AppShell";
import { useAppHotkeys } from "@/hooks/useHotkeys";
import { startBridge } from "@/lib/bridge";

export function App() {
  useAppHotkeys();

  useEffect(() => {
    const bridge = startBridge();
    bridge.catch((reason: unknown) => {
      console.error("ircx could not reach its backend", reason);
    });
    return () => {
      void bridge.then((stop) => stop()).catch(() => {});
    };
  }, []);

  return (
    <>
      <AppShell drawer={<Drawer />}>
        <PaneTree />
      </AppShell>

      <CommandPalette />
      <SearchOverlay />
    </>
  );
}
