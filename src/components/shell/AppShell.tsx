import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { SidebarNetworks } from "./SidebarNetworks";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { loadViewState, saveViewState } from "./viewState";

/** Below this the sidebar becomes an overlay rather than a column. */
const NARROW_PX = 900;
const HANDLE_PX = 4;

export function AppShell({ children }: { children?: ReactNode }) {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const collapsedNetworks = useAppStore((s) => s.collapsedNetworks);

  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  const [sidebarOverlay, setSidebarOverlay] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const isNarrow = window.innerWidth < NARROW_PX;
      setNarrow(isNarrow);
      if (!isNarrow) setSidebarOverlay(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const restored = useRef(false);
  useEffect(() => {
    const stored = loadViewState();
    restored.current = true;
    if (!stored) return;
    useAppStore.setState({
      sidebarWidth: stored.sidebarWidth,
      collapsedNetworks: Object.fromEntries(stored.collapsedNetworks.map((id) => [id, true])),
    });
  }, []);

  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveViewState({
      sidebarWidth,
      collapsedNetworks: Object.keys(collapsedNetworks).filter((id) => collapsedNetworks[id]),
    });
  }, [sidebarWidth, collapsedNetworks]);

  const columns = narrow ? "1fr" : `${sidebarWidth}px ${HANDLE_PX}px minmax(0, 1fr)`;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] bg-[var(--surface-base)]">
      <TitleBar
        onToggleSidebar={narrow ? () => setSidebarOverlay((open) => !open) : undefined}
      />

      <div
        className="relative grid min-h-0"
        style={{ gridTemplateColumns: columns }}
      >
        {(!narrow || sidebarOverlay) && (
          <div
            className={
              narrow
                ? "absolute inset-y-0 left-0 z-20 shadow-[var(--shadow-overlay)]"
                : "min-w-0"
            }
            style={narrow ? { width: sidebarWidth } : undefined}
          >
            <SidebarNetworks />
          </div>
        )}

        {!narrow && <SidebarHandle />}

        <main className="min-w-0 overflow-hidden">{children}</main>
      </div>

      <StatusBar />
    </div>
  );
}

function SidebarHandle() {
  const width = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={width}
      aria-valuemin={180}
      aria-valuemax={400}
      tabIndex={0}
      className="cursor-col-resize bg-transparent hover:bg-[var(--accent-muted)]"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragging) setSidebarWidth(event.clientX);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") setSidebarWidth(width - 16);
        else if (event.key === "ArrowRight") setSidebarWidth(width + 16);
        else return;
        event.preventDefault();
      }}
    />
  );
}
