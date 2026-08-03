import { useEffect, useRef } from "react";
import clsx from "clsx";
import { Composer } from "@/components/composer/Composer";
import { ContextPanel } from "@/components/drawer/ContextPanel";
import { ChannelHeader } from "@/components/header/ChannelHeader";
import { Timeline } from "@/components/timeline/Timeline";
import { useAppStore } from "@/store";
import { useView } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { SERVER_TARGET } from "@/types";
import { ServerConsole } from "./ServerConsole";

/** One split: its own target, scroll position, and draft. */
export function ChatPane({ view }: { view: ViewId | null }) {
  const pane = useView(view);
  const focusView = useAppStore((s) => s.focusView);
  const split = useAppStore((s) => s.viewOrder.length > 1);
  const active = useAppStore((s) => s.activeViewId === view);
  // The roster belongs to this conversation, so it is drawn here rather than
  // in a shared sidebar deciding which pane to point at. A pane on a console or
  // a query has nobody to list and draws no column at all.
  const hidden = useAppStore((s) => (view ? s.rosterHidden[view] === true : true));
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

  // The console is a pane on the network rather than on a conversation: no
  // members, no drafts, nobody to report typing to.
  const consoleFor = pane?.network && pane.target === SERVER_TARGET ? pane.network : null;
  const name = consoleFor ? `${consoleFor} console` : pane?.target || pane?.network || "Empty";

  return (
    <section
      ref={ref}
      data-view={view ?? undefined}
      aria-label={`${name} pane`}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      className={clsx(
        // A container so the roster can answer to this pane's width rather than
        // the window's: two panes side by side are the same window and very
        // different widths, and it is the pane the roster has to fit inside.
        "@container flex h-full min-h-0 min-w-0",
        // The rule is the focus indicator and only earns its pixel once there
        // is more than one pane to tell apart.
        split &&
          (active
            ? "border-t border-[var(--border-strong)]"
            : "border-t border-transparent"),
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {consoleFor ? (
          <ServerConsole view={view} network={consoleFor} />
        ) : (
          <>
            <ChannelHeader view={view} />
            <div className="min-h-0 flex-1">
              <Timeline view={view} />
            </div>
            <Composer view={view} />
          </>
        )}
      </div>

      {/* Beside the whole column rather than under the header, so the panel's
          own header lands on the same rule as this pane's. */}
      {!hidden && !consoleFor && <ContextPanel view={view} />}
    </section>
  );
}
