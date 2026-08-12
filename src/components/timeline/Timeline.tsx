import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage, PageBackOutcome } from "@/types";
import { ipc } from "@/lib/ipc";
import { EMPTY_TIMELINE, TIMELINE_CAP, serverMsgid, useAppStore } from "@/store";
import { targetKey, useMembers, useTimelineForView, useView, type HighlightRule } from "@/store/selectors";
import type { TimelineState, ViewId } from "@/store/types";
import { DateSeparator, HistoryDivider, UnreadDivider } from "./Divider";
import { assignGroups } from "./groups";
import { MessageBlock } from "./MessageBlock";
import { SystemMessage } from "./SystemMessage";
import { TypingIndicator } from "./TypingIndicator";
import { buildRows, rowIndexOfMessage, rowMessages, type TimelineRow } from "./rows";

import { usePrependAnchor, type Offsets } from "./scrollAnchor";

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
  const highlightWords = useAppStore((s) => s.highlightWords);
  // One object, so everything below decides loudness from the same pair rather
  // than half of it.
  const highlight = useMemo<HighlightRule>(
    () => ({ nick: ownNick, words: highlightWords }),
    [ownNick, highlightWords],
  );
  const canTag = useAppStore(
    (s) => s.networks[network]?.capsEnabled.includes("message-tags") ?? false,
  );
  const [flashId, setFlashId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The message the server was asked the page behind, when that ask passed its
  // deadline with no answer. The request is still out and the page may still
  // arrive — and when it does, the conversation's oldest message is no longer
  // this one, which is what takes the line back off the head (#491).
  const [waitingBehind, setWaitingBehind] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read once: from the restore onwards the scroller owns the position, and
  // reading it as a subscription would fight every scroll event with a stale
  // value. Cleared when the pane is back where it was and the reader has it.
  const restoreTo = useRef(useAppStore.getState().viewAnchor[view] ?? null);
  const followingRef = useRef(restoreTo.current === null);

  const { messages, unreadFrom } = timeline;

  // Who is in the channel, which is what tells an address from a colon.
  const members = useMembers(network, target);
  const present = useMemo(() => members.map((member) => member.nick), [members]);
  const groups = useMemo(() => assignGroups(messages, present), [messages, present]);
  // Folded once here rather than per message: who is in the conversation is
  // what tells somebody addressing the reader from a service talking about
  // them.
  const roster = useMemo(
    () => new Set(present.map((nick) => nick.toLowerCase())),
    [present],
  );

  const rows = useMemo(
    () => buildRows(messages, unreadFrom, highlight, groups, roster),
    [messages, unreadFrom, highlight, groups, roster],
  );
  // A `+reply` names its parent the way the server does, and for a message we
  // sent that is the `msgid` tag its echo carried, not the local id the UI drew
  // it with. Both names have to reach the same message or a reply to your own
  // line quotes nothing.
  const byId = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) {
      map.set(m.id, m);
      const server = serverMsgid(m);
      if (server !== null) map.set(server, m);
    }
    return map;
  }, [messages]);

  const waiting = waitingBehind !== null && messages[0]?.id === waitingBehind;
  const head = rows.length === 0 ? null : historyHead(timeline, loadError, waiting);
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

  // The anchor works in messages, the virtualiser in rows, and this is the
  // whole of the translation. A row that holds none — a date, a seam — cannot
  // name the reader's place, so the search runs forward to one that can.
  const offsets = useMemo<Offsets>(
    () => ({
      offsetOfMessage: (id) => {
        const index = rowIndexOfMessage(rows, id);
        if (index === -1) return undefined;
        // For the side effect, and it is the whole reason the anchor works.
        // `getOffsetForIndex` reads a cache of the measurements rather than the
        // measurements, and rows measured in this commit's ref callbacks are
        // not in it yet; `getTotalSize` is the public call that recomputes
        // them. Without this the offset is the one the estimate gave, which is
        // the bug the anchor is here to fix (#477).
        virtualizer.getTotalSize();
        return virtualizer.getOffsetForIndex(index, "start")?.[0];
      },
      messageAtOffset: (offset) => {
        const from = virtualizer.getVirtualItemForOffset(offset)?.index;
        if (from === undefined) return undefined;
        for (let index = from; index < rows.length; index++) {
          const first = rowMessages(rows[index]!)[0];
          if (first) return first.id;
        }
        return undefined;
      },
    }),
    [rows, virtualizer],
  );

  const recordAnchor = usePrependAnchor(scrollRef, headRef, messages, offsets);

  // On the messages rather than the row count: a message that merges into the
  // row already open moves the tail without adding a row, and a console's whole
  // content is the kind of row that merges.
  useLayoutEffect(() => {
    if (followingRef.current && rows.length > 0) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [messages, rows.length, virtualizer]);

  // Through the virtualiser rather than by assigning `scrollTop`: an offset is
  // only a place at the width it was measured at, and a rebuilt pane is a
  // different width (#307).
  //
  // Re-asserted every render until the reader takes over, rather than done once.
  // A pane is rebuilt before it is laid out and before its archive has been read
  // back, so the first attempt often has no row to scroll to or no room to
  // scroll in; and even after it lands, the virtualiser goes on adjusting the
  // scroller as it measures rows for real, which walks the pane back to the top.
  // Landing is therefore not the end of it. Once the row is where it should be
  // this does nothing, so the loop settles as soon as the measurements do.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (restoreTo.current === null || !el || el.clientHeight === 0) return;
    const index = rows.findIndex((row) => row.id === restoreTo.current);
    if (index === -1) return;
    const target = virtualizer.getOffsetForIndex(index, "start")?.[0];
    if (target !== undefined && Math.abs(el.scrollTop - target) <= 1) return;
    virtualizer.scrollToIndex(index, { align: "start" });
  });

  /** The reader has taken the pane over, so stop putting it back. Anything that
   * moves a scroller by hand — a wheel, a drag of the bar, a key — rather than
   * `scroll` itself, which the restore also raises. */
  const takeOver = useCallback(() => {
    restoreTo.current = null;
  }, []);

  /** Says which of the three things happened, because the caller below cannot
   * tell them apart from the outside and one of them is not an answer: a call
   * that skipped because a read was already running looks exactly like a read
   * that came back with nothing. */
  const loadOlder = useCallback(async (): Promise<"skipped" | "read" | "failed"> => {
    const key = targetKey(network, target);
    const store = useAppStore.getState();
    // A channel restored across a restart has no entry at all until something
    // is filed under it, and that is exactly the pane with an archive to read.
    const current = store.timelines[key] ?? EMPTY_TIMELINE;
    if (!current.hasMore || current.loadingOlder) return "skipped";
    // Nothing has moved since the server was asked for the page behind this
    // very message, so the archive can only answer what it answered then and
    // the request would come out identical (#487).
    if (current.messages[0]?.id === current.askedBehind) return "skipped";

    store.setLoadingOlder(key, true);
    try {
      const older = await ipc.loadHistory({
        network,
        target,
        before: current.messages[0]?.timestamp ?? null,
        limit: PAGE_SIZE,
      });
      setLoadError(null);
      // A full page leaves more on disk, so the archive is still the answer to
      // the next scroll and the server is not asked at all. A short one is the
      // archive running out, which is not the same as the history running out:
      // what is behind it is on the server, and #472 is that this used to be
      // where the pane gave up and said so.
      // The oldest of the window and the page together, read after the await
      // rather than from the snapshot taken before it. `older[0]` is the
      // conversation's oldest only while the page is behind the window, and a
      // pane opening on an empty timeline has no message to ask the archive
      // from — so it asks with `before` null, which is answered with the newest
      // page the archive holds. The server's own history lands while that read
      // is in flight, and asking from today's row asks again for the page that
      // just arrived (#496).
      const live = useAppStore.getState().timelines[key]?.messages ?? current.messages;
      const oldest = olderOf(older[0], live[0]);
      let more = older.length === PAGE_SIZE;
      let outcome: PageBackOutcome | null = null;
      if (!more) {
        // Named before the request goes out, and it is the conversation's own
        // oldest message once this page is filed: what the guard above compares
        // against on every scroll event until the page lands.
        store.setAskedBehind(key, oldest?.id ?? null);
        outcome = await pageBack(network, target, oldest);
        // A server that has not answered yet has not said the history ends
        // here either, so the pane keeps both the page it is owed and the one
        // that may be behind it.
        more = outcome !== "end";
      }
      setWaitingBehind(outcome === "waiting" ? (oldest?.id ?? null) : null);
      useAppStore.getState().prependHistory(key, older, more);
      return "read";
    } catch (e) {
      setLoadError(String(e));
      useAppStore.getState().setLoadingOlder(key, false);
      return "failed";
    }
  }, [network, target]);

  // A pane holding less than a screenful cannot be scrolled, so the handler
  // below never fires and the rest of the archive is out of reach. Priming it
  // with a single page is not enough: a run of joins and quits folds into one
  // digest row, so a channel whose history is mostly presence comes back short
  // however much is behind it, and 200 more messages can add no height at all
  // (#331). So this reads until there is something to scroll.
  //
  // Bounded at both ends. `hasMore` goes false at the start of the archive, and
  // `TIMELINE_CAP` is as much as the window is meant to hold — the same answer
  // `messagesAppended` gives at the other end. A page that adds nothing stops
  // it too, which is what a failed read looks like from here.
  const stalled = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (stalled.current || !el) return;
    if (el.scrollHeight - el.clientHeight > LOAD_OLDER_PX) return;
    if (!timeline.hasMore || timeline.loadingOlder) return;
    if (messages.length >= TIMELINE_CAP) return;

    const held = messages.length;
    void loadOlder().then((outcome) => {
      // A skip is another read already in flight, which is not this pane
      // running out of things to ask for. Latching on it stopped the loop after
      // one page, which is the whole of what #331 was.
      if (outcome === "skipped") return;
      const key = targetKey(network, target);
      const now = useAppStore.getState().timelines[key]?.messages.length ?? held;
      if (outcome === "failed" || now === held) stalled.current = true;
    });
  }, [loadOlder, messages, timeline.hasMore, timeline.loadingOlder, network, target]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    recordAnchor();
    // A pane waiting to be put back is at the top because nothing has moved it
    // yet, not because anybody read their way there. Recording that would
    // overwrite the row it is being put back to, which is how the position used
    // to be lost rather than merely missed (#307).
    if (restoreTo.current !== null) return;
    const following = el.scrollHeight - el.scrollTop - el.clientHeight < STUCK_PX;
    followingRef.current = following;
    // The row at the top of the screen, not the offset it happens to sit at: a
    // rebuilt pane comes back a different width, where the same offset is a
    // different message. A pane at the live edge has no row to name — it wants
    // whatever is newest, which is what `null` says.
    //
    // Off the measurement cache rather than off `getVirtualItems`, which
    // reports the window last rendered: the virtualiser and this handler both
    // answer the same scroll event, and the one that runs first sees the range
    // from before it. Offsets are measured from the top of the scroller, the
    // head included, so `scrollTop` is the right question to ask.
    const top = following ? undefined : virtualizer.getVirtualItemForOffset(el.scrollTop);
    useAppStore
      .getState()
      .setViewAnchor(view, top === undefined ? null : (rows[top.index]?.id ?? null));
    if (el.scrollTop < LOAD_OLDER_PX) void loadOlder();
  }, [loadOlder, view, rows, virtualizer, recordAnchor]);

  const jump = useCallback(
    (msgid: string) => {
      // Rows and the flash are keyed by the id the UI drew, so the server's
      // name for the message has to be resolved to it first.
      const id = byId.get(msgid)?.id;
      if (id === undefined) return;
      const index = rowIndexOfMessage(rows, id);
      if (index === -1) return;
      followingRef.current = false;
      virtualizer.scrollToIndex(index, { align: "center" });
      setFlashId(id);
    },
    [byId, rows, virtualizer],
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
    <div className="flex h-full min-h-0 flex-col" data-ui="timeline">
      <div className="min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={takeOver}
          onPointerDown={takeOver}
          onKeyDown={takeOver}
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
                  highlight,
                  parentOf,
                  onJump: jump,
                  canTag,
                  onReact: react,
                  onReply: reply,
                  flashId,
                  present: roster,
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
 * Whichever of two messages the conversation reached first, either of them
 * possibly being absent. A stamp that will not parse loses, which sends the
 * server the one that will.
 */
function olderOf(
  a: ChatMessage | undefined,
  b: ChatMessage | undefined,
): ChatMessage | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a.timestamp) <= Date.parse(b.timestamp) ? a : b;
}

/**
 * Asks the server for the page behind `oldest`, and answers whether another may
 * be behind that one — or that the server has not said yet.
 *
 * No message to ask from means an empty conversation, where the page a join asks
 * for is what fills it and there is nothing to reach back past. A msgid is sent
 * only where the server minted it — the same rule as a reaction's — because a
 * local id names nothing it can resolve, and the timestamp beside it is what
 * every server can answer.
 */
async function pageBack(
  network: string,
  target: string,
  oldest: ChatMessage | undefined,
): Promise<PageBackOutcome> {
  if (!oldest) return "end";
  return ipc.pageBack(network, target, oldest.timestamp, oldest.idIsLocal ? null : oldest.id);
}

/**
 * What the head of the scrolled content says about the history above it. It is
 * a line of the timeline rather than a layer over one: "Beginning of history"
 * is permanent for every conversation whose archive and whose server have both
 * run out, and being scrolled to the top is exactly when a layer would cover
 * something.
 */
function historyHead(
  timeline: TimelineState,
  loadError: string | null,
  waiting: boolean,
): string | null {
  if (loadError !== null) return loadError;
  if (timeline.loadingOlder) return "Loading older messages";
  // Said in the faint colour the rest of these are, because a page the server
  // is taking its time over is not a failure to report: it arrives and draws,
  // and this line goes when it does. Reporting it as one is what told the
  // reader to reconnect a network that was answering (#491).
  if (waiting) return "The server has not sent this page yet";
  return timeline.hasMore ? null : "Beginning of history";
}

export interface RowContext {
  ownNick: string | null;
  /** The reader's nick and the words beside it. Carried with the rest of the
   * row's context so the appearance preview, which builds one of these by
   * hand, decides loudness the way the client does. */
  highlight: HighlightRule;
  parentOf: (msgid: string) => ChatMessage | undefined;
  onJump: (msgid: string) => void;
  canTag: boolean;
  onReact: (msgid: string, emoji: string, active: boolean) => void;
  onReply: (msgid: string) => void;
  flashId: string | null;
  present: ReadonlySet<string>;
}

/** One row of a conversation, whichever of the five kinds it is. Exported so
 * the appearance preview draws its sample channel down this same path: a
 * preview that reimplemented the rows would be a drawing of the settings
 * rather than the settings. */
export function renderRow(row: TimelineRow, context: RowContext) {
  if (row.kind === "unread") return <UnreadDivider seam={row.seam} />;
  if (row.kind === "history") return <HistoryDivider opens={row.opens} />;
  if (row.kind === "date") return <DateSeparator at={row.at} />;
  if (row.kind === "system")
    return <SystemMessage messages={row.messages} ownNick={context.ownNick} />;
  return (
    <MessageBlock
      messages={row.messages}
      group={row.group}
      opensGroup={row.opensGroup}
      {...context}
    />
  );
}
