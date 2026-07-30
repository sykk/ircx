import { useEffect, useRef } from "react";
import clsx from "clsx";
import { Composer } from "@/components/composer/Composer";
import { ContextPanel } from "@/components/drawer/ContextPanel";
import { ChannelHeader } from "@/components/header/ChannelHeader";
import { Timeline } from "@/components/timeline/Timeline";
import { useAppStore } from "@/store";
import { useView } from "@/store/selectors";
import type { ViewId } from "@/store/types";

/** One split: its own target, scroll position, and draft. */
export function ChatPane({ view }: { view: ViewId | null }) {
  const pane = useView(view);
  const focusView = useAppStore((s) => s.focusView);
  const split = useAppStore((s) => s.viewOrder.length > 1);
  const active = useAppStore((s) => s.activeViewId === view);
  const embedded = useAppStore(
    (s) => s.drawerOpen && s.contextMode === "embedded" && s.contextPane === view,
  );
  const ref = useRef<HTMLElement>(null);

  // A pane opened by a split arrives focused, so the caret follows into it.
  // Later focus changes are left alone: clicking into a pane to read or select
  // must not pull the caret out of what was clicked.
  const opened = useRef(true);
  useEffect(() => {
    if (!opened.current) return;
    opened.current = false;
    if (active && split) ref.current?.querySelector("textarea")?.focus();
  }, [active, split]);

  const focus = () => {
    if (view) focusView(view);
  };

  return (
    <section
      ref={ref}
      data-view={view ?? undefined}
      aria-label={`${pane?.target || pane?.network || "Empty"} pane`}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      className={clsx(
        "flex h-full min-h-0 min-w-0",
        // The rule is the focus indicator and only earns its pixel once there
        // is more than one pane to tell apart.
        split &&
          (active
            ? "border-t border-[var(--border-strong)]"
            : "border-t border-transparent"),
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChannelHeader view={view} />
        <div className="min-h-0 flex-1">
          <Timeline view={view} />
        </div>
        <Composer view={view} />
      </div>

      {/* Beside the whole column rather than under the header, so the panel's
          own header lands on the same rule as this pane's. */}
      {embedded && <ContextPanel view={view} embedded />}
    </section>
  );
}
