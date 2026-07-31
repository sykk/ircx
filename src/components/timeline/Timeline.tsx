import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage } from "@/types";
import { ipc } from "@/lib/ipc";
import { EMPTY_TIMELINE, useAppStore } from "@/store";
import { targetKey, useTimelineForView, useView } from "@/store/selectors";
import type { TimelineState, ViewId } from "@/store/types";
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
  const canTag = useAppStore(
    (s) => s.networks[network]?.capsEnabled.includes("message-tags") ?? false,
  );
  const [flashId, setFlashId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read once: after the restore the scroller owns the position, and reading it
  // as a subscription would fight every scroll event with a stale value.
  const restoreTo = useRef(useAppStore.getState().views[view]?.scrollPosition ?? 0);
  const followingRef = useRef(restoreTo.current === 0);

  const { messages, unreadFrom } = timeline;

  const rows = useMemo(
    () => buildRows(messages, unreadFrom, ownNick),
    [messages, unreadFrom, ownNick],
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const head = rows.length === 0 ? null : historyHead(timeline, loadError);
  const headRef = useRef<HTMLDivElement>(null);
  // The head is the first thing in the scroller, so the list starts that far
  // down it. The virtualiser needs the offset to place rows and to scroll to
  // one; the rows themselves subtract it again, being laid out inside the list.
  const [headPx, setHeadPx] = useState(0);
  useLayoutEffect(() => {
    setHeadPx(headRef.current?.offsetHeight ?? 0);
  }, [head]);

  // React Compiler cannot memoize around the virtualiser's mutable instance, so
  // it skips this component. That is the trade for variable-height rows.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    scrollMargin: headPx,
    overscan: 10,
  });

  usePrependAnchor(scrollRef, messages);

  // On the messages rather than the row count: a message that merges into the
  // row already open moves the tail without adding a row, and a console's whole
  // content is the kind of row that merges.
  useLayoutEffect(() => {
    if (followingRef.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [messages, rows.length, virtualizer]);

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
    // A channel restored across a restart has no entry at all until something
    // is filed under it, and that is exactly the pane with an archive to read.
    const current = store.timelines[key] ?? EMPTY_TIMELINE;
    if (!current.hasMore || current.loadingOlder) return;

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

  // Nothing is drawn optimistically. A chip changes when the backend emits the
  // reaction back, which it does for our own copy as well as everyone else's,
  // so a send that never reaches the server leaves the chips where they were.
  // That is the report the rejection is swallowed in favour of: a reaction is
  // not worth interrupting the reader for.
  const react = useCallback(
    (msgid: string, emoji: string, active: boolean) => {
      void ipc.react(network, target, msgid, emoji, active).catch(() => undefined);
    },
    [network, target],
  );

  const reply = useCallback(
    (msgid: string) => useAppStore.getState().setReplyTo(network, target, msgid),
    [network, target],
  );

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="timeline-scroller"
          className="h-full overflow-x-hidden overflow-y-auto"
          style={{ overflowAnchor: "none" }}
        >
          {head !== null && (
            <div
              ref={headRef}
              data-testid="timeline-head"
              className="px-4 py-1 text-center text-[11px]"
              style={{ color: loadError ? "var(--danger)" : "var(--text-faint)" }}
            >
              {head}
            </div>
          )}
          <div
            data-testid="timeline-sizer"
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start - headPx}px)` }}
              >
                {renderRow(rows[item.index]!, {
                  ownNick,
                  parentOf,
                  onJump: jump,
                  canTag,
                  onReact: react,
                  onReply: reply,
                  flashId,
                })}
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
      </div>

      <TypingIndicator network={network} target={target} />
    </div>
  );
}

/**
 * What the head of the scrolled content says about the history above it. It is
 * a line of the timeline rather than a layer over one: "Beginning of history"
 * is permanent for every conversation short enough to hold its whole archive,
 * and being scrolled to the top is exactly when a layer would cover something.
 */
function historyHead(timeline: TimelineState, loadError: string | null): string | null {
  if (loadError !== null) return loadError;
  if (timeline.loadingOlder) return "Loading older messages";
  return timeline.hasMore ? null : "Beginning of history";
}

interface RowContext {
  ownNick: string | null;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  canTag: boolean;
  onReact: (msgid: string, emoji: string, active: boolean) => void;
  onReply: (msgid: string) => void;
  flashId: string | null;
}

function renderRow(row: TimelineRow, context: RowContext) {
  if (row.kind === "unread") return <UnreadDivider seam={row.seam} />;
  if (row.kind === "date") return <DateSeparator at={row.at} />;
  if (row.kind === "system")
    return <SystemMessage messages={row.messages} ownNick={context.ownNick} />;
  return <MessageBlock messages={row.messages} {...context} />;
}
