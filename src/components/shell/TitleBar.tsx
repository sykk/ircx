import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconButton } from "@/components/common/IconButton";
import { insideTauri } from "@/lib/ipc";
import { Tooltip } from "@/components/common/Tooltip";
import { useAppStore } from "@/store";
import { useNetworks } from "@/store/selectors";
import {
  connectionColor,
  connectionLabel,
  problemNetworks,
  useDisplayedNetwork,
  worstConnectionStatus,
} from "./connection";

/** `getCurrentWindow` reads globals the webview injects, so it throws under
 * vitest and in a plain browser. The controls go inert there instead. */
function appWindow() {
  return insideTauri() ? getCurrentWindow() : null;
}

export function TitleBar({ onToggleSidebar }: { onToggleSidebar?: (() => void) | undefined }) {
  const togglePalette = useAppStore((s) => s.togglePalette);
  const openSettings = useAppStore((s) => s.openSettings);
  const network = useDisplayedNetwork();
  const networks = useNetworks();
  const aggregateStatus = worstConnectionStatus(networks);
  const problems = problemNetworks(networks);
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
      data-ui="titlebar"
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

      <IconButton
        icon="settings"
        label="Settings"
        onClick={() => openSettings()}
      />

      <span data-tauri-drag-region className="h-full flex-1" />

      {network && (
        <Tooltip
          label={`${connectionLabel(network.status)} — ${network.host}:${network.port}${
            problems.length === 0
              ? ""
              : ` · ${problems.length} ${
                  problems.length === 1 ? "network needs" : "networks need"
                } attention`
          }`}
        >
          <span className="flex items-center gap-2 px-2 text-[11px] text-[var(--text-secondary)]">
            <span
              className="size-2 rounded-full"
              style={{ background: connectionColor(aggregateStatus ?? network.status) }}
            />
            {network.name}
            {problems.length > 0 && (
              <span
                aria-label={`${problems.length} ${
                  problems.length === 1 ? "network needs" : "networks need"
                } attention`}
                className="rounded-full border border-[var(--state-error)] px-1.5 text-[9px] tabular-nums text-[var(--state-error)]"
              >
                {problems.length}
              </span>
            )}
          </span>
        </Tooltip>
      )}

      <div className="ml-2 flex items-center gap-1 border-l border-[var(--border-default)] pl-2">
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
