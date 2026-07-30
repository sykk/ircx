import { useEffect } from "react";
import { Composer } from "@/components/composer/Composer";
import { Drawer } from "@/components/drawer/Drawer";
import { ChannelHeader } from "@/components/header/ChannelHeader";
import { CommandPalette, SearchOverlay } from "@/components/palette";
import { AppShell } from "@/components/shell/AppShell";
import { Timeline } from "@/components/timeline/Timeline";
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
        <div className="flex h-full min-h-0 flex-col">
          <ChannelHeader />
          <div className="min-h-0 flex-1">
            <Timeline />
          </div>
          <Composer />
        </div>
      </AppShell>

      <CommandPalette />
      <SearchOverlay />
    </>
  );
}
