import { useEffect, useState } from "react";
import { useTypingNicks } from "@/store/selectors";

/** Entries carry their own expiry, so the view has to re-check on a timer. */
const TICK_MS = 2_000;

function phrase(nicks: string[]): string {
  if (nicks.length === 1) return `${nicks[0]} is typing`;
  if (nicks.length === 2) return `${nicks[0]} and ${nicks[1]} are typing`;
  if (nicks.length === 3) return `${nicks[0]}, ${nicks[1]} and ${nicks[2]} are typing`;
  return `${nicks.length} people are typing`;
}

export function TypingIndicator({ network, target }: { network: string; target: string }) {
  // The selector filters on expiry but schedules nothing, so the timer is here.
  const [, tick] = useState(0);
  const nicks = useTypingNicks(network, target);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-ui="typing"
      className="h-[18px] px-4 text-[11px] leading-[18px]"
      style={{ color: "var(--text-muted)" }}
      aria-live="polite"
    >
      {nicks.length > 0 ? `${phrase(nicks)}…` : ""}
    </div>
  );
}
