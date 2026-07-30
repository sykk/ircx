import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconButton } from "@/components/common/IconButton";
import { Tooltip } from "@/components/common/Tooltip";
import { useAppStore } from "@/store";
import { connectionColor, connectionLabel, useDisplayedNetwork } from "./connection";

/** `getCurrentWindow` reads globals the webview injects, so it throws under
 * vitest and in a plain browser. The controls go inert there instead. */
function appWindow() {
  return "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;
}

export function TitleBar({ onToggleSidebar }: { onToggleSidebar?: (() => void) | undefined }) {
  const togglePalette = useAppStore((s) => s.togglePalette);
  const network = useDisplayedNetwork();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = appWindow();
    if (!win) return;
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    const stop = win.onResized(sync);
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-sidebar)] pr-1 pl-2"
    >
      {onToggleSidebar && (
        <IconButton icon="sidebar" label="Toggle sidebar" onClick={onToggleSidebar} />
      )}

      <span
        data-tauri-drag-region
        className="pl-1 text-[13px] font-semibold text-[var(--text-primary)]"
      >
        ircx
      </span>

      <button
        type="button"
        aria-label="Open command palette"
        onClick={() => togglePalette()}
        className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
      >
        Ctrl+K
      </button>

      <span data-tauri-drag-region className="h-full flex-1" />

      {network && (
        <Tooltip
          label={`${connectionLabel(network.status)} — ${network.host}:${network.port}`}
        >
          <span className="flex items-center gap-2 px-2 text-[11px] text-[var(--text-secondary)]">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: connectionColor(network.status) }}
            />
            {network.name}
          </span>
        </Tooltip>
      )}

      <div className="flex items-center gap-0.5 pl-1">
        <IconButton
          icon="minimize"
          label="Minimise"
          onClick={() => void appWindow()?.minimize()}
        />
        <IconButton
          icon={maximized ? "restore" : "maximize"}
          label={maximized ? "Restore" : "Maximise"}
          onClick={() => void appWindow()?.toggleMaximize()}
        />
        <IconButton icon="close" label="Close" onClick={() => void appWindow()?.close()} />
      </div>
    </header>
  );
}
