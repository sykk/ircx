import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { targetKey, useTimelineForView, useView } from "@/store/selectors";
import type { ViewId } from "@/store/types";
import { DateSeparator, UnreadDivider } from "./Divider";
import { MessageBlock } from "./MessageBlock";
import { SystemMessage } from "./SystemMessage";
import { TypingIndicator } from "./TypingIndicator";
import { buildRows, rowIndexOfMessage, type TimelineRow } from "./rows";
import { usePrependAnchor } from "./scrollAnchor";

const PAGE_SIZE = 200;
export const ESTIMATED_ROW_PX = 46;
/** Distance from the top that triggers the next page of history. */
const LOAD_OLDER_PX = 400;
/** Slack below the bottom that still counts as following the conversation. */
const STUCK_PX = 48;
const FLASH_MS = 1_200;

/**
 * The density knob. Every vertical measure in the timeline reads one of these,
 * so compact and read modes are this object plus somewhere to store the choice.
 */
const DENSITY = {
  "--row-pad-y": "1px",
  "--block-gap": "14px",
  "--body-leading": "1.7",
} as CSSProperties;

/**
 * The horizontal ladder, measured off `docs/chat-output.png`: the clock ends at
 * x=71, the spine sits at x=98, the nick column opens at x=120, and text runs
 * to a bounded measure. Every row reads these, so the columns hold whatever a
 * row turns out to contain.
 */
const LADDER = {
  "--rail-pad": "35px",
  "--clock-col": "36px",
  "--spine-gap": "27px",
  "--spine-w": "2px",
  "--nick-gap": "20px",
  "--text-gap": "16px",
  "--measure": "595px",
} as CSSProperties;

export function Timeline({ view }: { view: ViewId | null }) {
  const pane = useView(view);

  if (!pane || !pane.network) {
    return (
      <div className="grid h-full place-items-center text-[12px]" style={{ color: "var(--text-muted)" }}>
        No conversation open
      </div>
    );
  }

  // Remounting on target switch drops the measurement cache and fold state,
  // both of which belong to the conversation being left.
  const conversation = targetKey(pane.network, pane.target);
  return (
    <TimelineFor
      key={conversation}
      view={pane.id}
      network={pane.network}
      target={pane.target}
    />
  );
}

interface TimelineForProps {
  view: ViewId;
  network: string;
  target: string;
}

function TimelineFor({ view, network, target }: TimelineForProps) {
  const timeline = useTimelineForView(view);
  const ownNick = useAppStore((s) => s.networks[network]?.currentNick ?? null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read once: after the restore the scroller owns the position, and reading it
  // as a subscription would fight every scroll event with a stale value.
  const restoreTo = useRef(useAppStore.getState().views[view]?.scrollPosition ?? 0);
  const followingRef = useRef(restoreTo.current === 0);

  const { messages, unreadFrom, hasMore, loadingOlder } = timeline;

  const rows = useMemo(
    () => buildRows(messages, unreadFrom, ownNick),
    [messages, unreadFrom, ownNick],
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // React Compiler cannot memoize around the virtualiser's mutable instance, so
  // it skips this component. That is the trade for variable-height rows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 10,
  });

  usePrependAnchor(scrollRef, messages);

  useLayoutEffect(() => {
    if (followingRef.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [rows.length, virtualizer]);

  // Deferred until there is something to scroll: an empty scroller clamps any
  // offset back to zero and the position would be lost.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restoreTo.current === 0 || rows.length === 0) return;
    el.scrollTop = restoreTo.current;
    restoreTo.current = 0;
  }, [rows.length]);

  const loadOlder = useCallback(async () => {
    const key = targetKey(network, target);
    const store = useAppStore.getState();
    const current = store.timelines[key];
    if (!current || !current.hasMore || current.loadingOlder) return;

    store.setLoadingOlder(key, true);
    try {
      const older = await ipc.loadHistory({
        network,
        target,
        before: current.messages[0]?.timestamp ?? null,
        limit: PAGE_SIZE,
      });
      setLoadError(null);
      useAppStore.getState().prependHistory(key, older, older.length === PAGE_SIZE);
    } catch (e) {
      setLoadError(String(e));
      useAppStore.getState().setLoadingOlder(key, false);
    }
  }, [network, target]);

  // A pane holding less than a screenful cannot be scrolled, so the handler
  // below would never fire and a conversation that only exists in the archive
  // would stay empty for good. The component is keyed by conversation, so this
  // reads it once per target a pane shows.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.clientHeight > LOAD_OLDER_PX) return;
    void loadOlder();
  }, [loadOlder]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followingRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STUCK_PX;
    useAppStore.getState().setViewScroll(view, el.scrollTop);
    if (el.scrollTop < LOAD_OLDER_PX) void loadOlder();
  }, [loadOlder, view]);

  const jump = useCallback(
    (msgid: string) => {
      const index = rowIndexOfMessage(rows, msgid);
      if (index === -1) return;
      followingRef.current = false;
      virtualizer.scrollToIndex(index, { align: "center" });
      setFlashId(msgid);
    },
    [rows, virtualizer],
  );

  useEffect(() => {
    if (!flashId) return;
    const id = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flashId]);

  const parentOf = useCallback((msgid: string) => byId.get(msgid), [byId]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ ...DENSITY, ...LADDER }}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="timeline-scroller"
          className="h-full overflow-x-hidden overflow-y-auto"
          style={{ overflowAnchor: "none" }}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(rows[item.index]!, { ownNick, parentOf, onJump: jump, flashId })}
              </div>
            ))}
          </div>
          {rows.length === 0 && (
            <div
              className="grid h-full place-items-center text-[12px]"
              style={{ color: "var(--text-muted)" }}
            >
              Nothing here yet
            </div>
          )}
        </div>

        {(loadingOlder || loadError || !hasMore) && rows.length > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 px-4 py-1 text-center text-[11px]"
            style={{ color: loadError ? "var(--danger)" : "var(--text-faint)" }}
          >
            {loadError ?? (loadingOlder ? "Loading older messages" : "Beginning of history")}
          </div>
        )}
      </div>

      <TypingIndicator network={network} target={target} />
    </div>
  );
}

interface RowContext {
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  flashId: string | null;
}

function renderRow(row: TimelineRow, context: RowContext) {
  if (row.kind === "unread") return <UnreadDivider seam={row.seam} />;
  if (row.kind === "date") return <DateSeparator at={row.at} />;
  if (row.kind === "system") return <SystemMessage messages={row.messages} />;
  return <MessageBlock messages={row.messages} {...context} />;
}
