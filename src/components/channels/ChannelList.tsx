import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TextField } from "@/components/onboarding/fields";
import { ipc, reasonOr } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { ChannelListing } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";

const ROW_HEIGHT = 44;

/** Matches a channel by its name or by what its topic says it is about. */
function matches(listing: ChannelListing, needle: string): boolean {
  return (
    listing.name.toLowerCase().includes(needle) ||
    listing.topic.toLowerCase().includes(needle)
  );
}

/**
 * What a network answered `/list` with, as something to search rather than
 * something to scroll.
 *
 * Libera answers with about twenty-two thousand channels. Before #125 each one
 * became a console message, which lagged the client and pushed everything else
 * out of the buffer — and even instantly, twenty-two thousand lines in a log is
 * not how a person finds a channel.
 */
export function ChannelList() {
  const network = useAppStore((s) => s.channelsOpen);
  return network === null ? null : <Sheet network={network} />;
}

function Sheet({ network }: { network: string }) {
  const close = useAppStore((s) => s.showChannels);
  const held = useAppStore((s) => s.channelList[network]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  // Typing stays responsive while twenty-two thousand rows are re-filtered.
  const needle = useDeferredValue(filter).trim().toLowerCase();

  const shown = useMemo(() => {
    const all = held?.channels ?? [];
    return needle === "" ? all : all.filter((listing) => matches(listing, needle));
  }, [held, needle]);

  const dialog = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // Nothing the virtualiser returns leaves this component, so the compiler
  // skipping it costs nothing.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // The sheet stays open on a failure so the reason has somewhere to be read,
  // as the palette does; a devtools warning is invisible to the person who
  // clicked.
  async function join(name: string) {
    try {
      await ipc.joinChannel(network, name);
      close(null);
    } catch (reason) {
      setError(reasonOr(reason, `${name} could not be joined.`));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={() => close(null)}
    >
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`Channels on ${network}`}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close(null);
        }}
        className="relative flex h-[70vh] w-[min(680px,92vw)] flex-col rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] shadow-[var(--shadow-overlay)]"
      >
        <div className="flex flex-col gap-3 p-5 pb-3">
          <h2 className="text-[15px] font-medium text-[var(--text-primary)]">
            Channels on {network}
          </h2>
          <TextField
            label="Filter"
            value={filter}
            onChange={setFilter}
            placeholder="Filter by name or topic"
            autoFocus
            hint={summary(shown.length, held?.channels.length ?? 0, held?.truncated ?? false)}
          />
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {shown.length === 0 ? (
            <p className="px-3 py-4 text-[12px] text-[var(--text-muted)]">
              {held === undefined
                ? "Nothing listed yet. Run /list to ask the server."
                : "No channel here matches that."}
            </p>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const listing = shown[item.index];
                if (!listing) return null;
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    onClick={() => void join(listing.name)}
                    className="absolute top-0 left-0 flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="truncate font-medium text-[13px] text-[var(--text-primary)]">
                        {listing.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-[11px] text-[var(--text-muted)]">
                        {listing.users}
                      </span>
                    </span>
                    {listing.topic !== "" && (
                      <span className="w-full truncate text-[11px] text-[var(--text-secondary)]">
                        {listing.topic}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {error !== null && (
          <p
            role="alert"
            className="border-t border-[var(--border-subtle)] px-5 py-3 text-[12px] text-[var(--danger)]"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** How much of the list is on screen, and whether the server sent more than
 * ircx kept. */
function summary(shown: number, total: number, truncated: boolean): string {
  const of = shown === total ? `${total}` : `${shown} of ${total}`;
  const counted = `${of} ${total === 1 ? "channel" : "channels"}`;
  return truncated ? `${counted}, and the server had more than ircx keeps` : counted;
}
