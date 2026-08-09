import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "@/components/common/Icon";
import { IconButton } from "@/components/common/IconButton";
import { insideTauri } from "@/lib/ipc";

/** `getCurrentWindow` reads globals the webview injects, so it throws under
 * vitest and in a plain browser. The controls go inert there instead — the
 * same bargain src/components/shell/TitleBar.tsx makes. */
function settingsWindow() {
  return insideTauri() ? getCurrentWindow() : null;
}

/**
 * The settings window is `decorations: false` like the client's, so it draws
 * its own bar. Its own rather than the client's: this one names the window
 * instead of the network, and has no palette button, there being nothing here
 * for the palette to jump to.
 */
export function SettingsTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = settingsWindow();
    if (!win) return;
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    const stop = win.onResized(sync);
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  return (
    <header
      data-tauri-drag-region
      data-ui="titlebar"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-sidebar)] pr-1 pl-3"
    >
      <span className="text-[var(--text-muted)]">
        <Icon name="settings" />
      </span>
      <span
        data-tauri-drag-region
        className="text-[13px] font-semibold text-[var(--text-primary)]"
      >
        ircx Settings
      </span>

      <span data-tauri-drag-region className="h-full flex-1" />

      <div className="flex items-center gap-0.5">
        <IconButton
          icon="minimize"
          label="Minimise"
          onClick={() => void settingsWindow()?.minimize()}
        />
        <IconButton
          icon={maximized ? "restore" : "maximize"}
          label={maximized ? "Restore" : "Maximise"}
          onClick={() => void settingsWindow()?.toggleMaximize()}
        />
        <IconButton
          icon="close"
          label="Close settings"
          onClick={() => void settingsWindow()?.close()}
        />
      </div>
    </header>
  );
}
