import clsx from "clsx";
import { useAppStore } from "@/store";
import type { ViewId } from "@/store/types";
import type { Network } from "@/types";
import { HeaderButton } from "./HeaderButton";
import { WireIcon } from "./icons";

interface Props {
  view: ViewId | null;
  network: Network;
  /** Whether the pane is showing the raw protocol log rather than the console. */
  raw: boolean;
  onToggleRaw: () => void;
}

export function ConsoleHeader({ view, network, raw, onToggleRaw }: Props) {
  const focused = useAppStore((s) => s.viewOrder.length < 2 || s.activeViewId === view);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--surface-base)] px-3">
      <h1
        className={clsx(
          "shrink-0 text-[15px] font-medium",
          focused ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]",
        )}
      >
        {network.name}
      </h1>
      <span className="min-w-0 truncate text-[var(--text-muted)]">
        {raw ? "raw protocol" : `${network.host}:${network.port}`}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <HeaderButton
          label="Raw protocol log"
          title={`Raw protocol log for ${network.name}`}
          pressed={raw}
          onClick={onToggleRaw}
        >
          <WireIcon size={16} />
        </HeaderButton>
      </div>
    </header>
  );
}
