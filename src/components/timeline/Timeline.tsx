import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage, PageBackOutcome } from "@/types";
import { ipc } from "@/lib/ipc";
import { probe } from "@/lib/probe";
import { EMPTY_TIMELINE, TIMELINE_CAP, serverMsgid, useAppStore } from "@/store";
import { targetKey, useMembers, useTimelineForView, useView, type HighlightRule } from "@/store/selectors";
import type { TimelineState, ViewId } from "@/store/types";
import { DateSeparator, HistoryDivider, UnreadDivider } from "./Divider";
import { assignGroups } from "./groups";
import { MessageBlock } from "./MessageBlock";
import { SystemMessage } from "./SystemMessage";
import { TypingIndicator } from "./TypingIndicator";
import { buildRows, rowIndexOfMessage, rowMessages, type TimelineRow } from "./rows";

import { raisedByAnchor, usePrependAnchor, type Offsets } from "./scrollAnchor";

const PAGE_SIZE = 200;
export const ESTIMATED_ROW_PX = 46;
/** Distance from the top that triggers the next page of history. */
export const LOAD_OLDER_PX = 400;
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
  // Whether the page in flight is one this pane asked for. `loadingOlder` is
  // the conversation's, and a split can hold one channel twice, so the store
  // alone says "loading" over a reader who asked for nothing (#516). The rest
  // of the head is already the pane's own: this is what makes that line so.
  const [askedForPage, setAskedForPage] = useState(false);
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

  // The read is over, whoever it belonged to, so the next one has to be asked
  // for again before this pane draws anything about it.
  useEffect(() => {
    if (!timeline.loadingOlder) setAskedForPage(false);
  }, [timeline.loadingOlder]);

  const waiting = waitingBehind !== null && messages[0]?.id === waitingBehind;
  const loadingHere = timeline.loadingOlder && askedForPage;
  const head = rows.length === 0 ? null : historyHead(timeline, loadError, waiting, loadingHere);
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

  /**
   * How far into its row a message's own line is drawn, and undefined where the
   * row is not on the screen to be measured.
   *
   * The DOM rather than the virtualiser, which measures rows and cannot answer
   * this. It is the distance between two boxes inside one row, so the transform
   * the row is drawn at — a render behind on the commit a page lands in, which
   * is what #477 is about — cancels out of it.
   *
   * Undefined rather than zero, and the difference is the whole of what makes
   * this safe. The rows rendered on the commit a page lands in are the ones the
   * *old* scroll offset asks for, which after two hundred messages arrive above
   * the reader is a window that does not hold them; answering 0 there would move
   * every reader by the name over their own run. The anchor keeps what it last
   * measured for exactly this.
   */
  const lineWithinRow = useCallback((id: string) => {
    const drawn = scrollRef.current?.querySelectorAll<HTMLElement>("[data-msgid]");
    // Compared rather than selected on: an id is the server's or this client's
    // and neither is written to be a selector, and `CSS.escape` is not in every
    // environment this renders in.
    const line = [...(drawn ?? [])].find((candidate) => candidate.dataset.msgid === id);
    const row = line?.closest<HTMLElement>("[data-index]");
    if (!line || !row) return undefined;
    return line.getBoundingClientRect().top - row.getBoundingClientRect().top;
  }, []);

  /** The row drawn at a place in the list, or null where it is off the screen.
   * An index is this component's own number and safe to select on, which an id
   * is not. */
  const drawnRow = useCallback(
    (index: number) => scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null,
    [],
  );

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
      lineWithinRow,
      rowUnmeasured: (id) => {
        const index = rowIndexOfMessage(rows, id);
        if (index === -1) return false;
        const drawn = drawnRow(index);
        if (drawn === null) return false;
        virtualizer.getTotalSize();
        const known = virtualizer.getVirtualItems().find((item) => item.index === index)?.size;
        // A fraction of a pixel is a browser rounding a border box, not a
        // measurement the virtualiser has yet to hear about.
        return known !== undefined && Math.abs(known - drawn.offsetHeight) > 1;
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
    [rows, virtualizer, lineWithinRow, drawnRow],
  );

  // `headPx` and not the head itself: it is the margin the offsets above were
  // measured against, and the anchor needs both to tell one from the other on
  // the commit they disagree.
  const { record: recordAnchor, release: releaseAnchor } = usePrependAnchor(
    scrollRef,
    headRef,
    messages,
    offsets,
    headPx,
    view,
  );

  // On the messages rather than the row count: a message that merges into the
  // row already open moves the tail without adding a row, and a console's whole
  // content is the kind of row that merges.
  useLayoutEffect(() => {
    if (followingRef.current && rows.length > 0) {
      probe("follow", { view, rows: rows.length });
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }
  }, [messages, rows.length, virtualizer, view]);

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
    probe("restore", { view, index, target: target ?? null, top: el.scrollTop });
    virtualizer.scrollToIndex(index, { align: "start" });
  });

  /** The reader has taken the pane over, so stop putting it back. Anything that
   * moves a scroller by hand — a wheel, a drag of the bar, a key — rather than
   * `scroll` itself, which the restore also raises.
   *
   * The anchor stands down on the same signal and for the same reason (#532):
   * while a landed page is still measuring, a `scrollTop` that moved is the
   * virtualiser correcting itself rather than anybody reading. */
  const takeOver = useCallback(() => {
    restoreTo.current = null;
    releaseAnchor();
  }, [releaseAnchor]);

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
    if (!current.hasMore) return "skipped";
    // A read for this very page is already out, from this pane or the one
    // beside it. Either way the answer is owed to this reader too, so the pane
    // is waiting on it and says so.
    if (current.loadingOlder) {
      setAskedForPage(true);
      return "skipped";
    }
    // Nothing has moved since the server was asked for the page behind this
    // very message, so the archive can only answer what it answered then and
    // the request would come out identical (#487).
    if (current.messages[0]?.id === current.askedBehind) return "skipped";

    setAskedForPage(true);
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
      const live = useAppStore.getState().timelines[key] ?? current;
      const oldest = olderOf(older[0], live.messages[0]);
      let more = older.length === PAGE_SIZE;
      let outcome: PageBackOutcome | null = null;
      let armed = false;
      if (!more) {
        // How many pages of server history this conversation has taken, read
        // immediately before the ask — off `live` rather than off the snapshot
        // this call opened with, because the archive read is awaited and the
        // server's own history lands during it, which is #496's whole shape.
        //
        // What it is for: telling the answer from the answer having arrived.
        // The two cross on different channels — the batch is an event, this is
        // a command's return — and core emits the batch first, so by the time
        // the outcome is read the page it describes has usually landed already.
        // Usually is not a thing to build on. #522.
        const landedBefore = live.historyLanded;
        outcome = await pageBack(network, target, oldest);
        // A server that has not answered yet has not said the history ends
        // here either, so the pane keeps both the page it is owed and the one
        // that may be behind it.
        more = outcome !== "end";
        const held = useAppStore.getState().timelines[key];
        const answered = (held?.historyLanded ?? landedBefore) > landedBefore;
        const stillOldest = (held?.messages[0]?.id ?? oldest?.id) === oldest?.id;
        if (outcome === "more" && answered && stillOldest) {
          // The page came back, and there was nothing in it this window did not
          // already hold. That is the server saying it has nothing behind this
          // message, whatever the page's size said about fullness, so the pane
          // stops paging and says where the history ends rather than refusing
          // every later scroll in silence.
          more = false;
        } else if (outcome === "more") {
          // Armed only here: a question went to the server and its answer has
          // not crossed yet, which is the window #487 was — the same msgid
          // asked again by every scroll event of one wheel burst. It comes off
          // when the batch lands, in the store, because a batch that carries
          // nothing new moves no message for it to come off by.
          //
          // `deferred` is not armed at all. Nothing went out for it: the
          // conversation's own first page is already coming and is what
          // answered, and that page says nothing about what is behind the
          // window — so a reader who scrolls again is asking a question nobody
          // has put yet, and the guard would refuse it for the rest of the run.
          // `waiting` is not armed either, being the round trip already spent.
          armed = true;
        }
      }
      setWaitingBehind(outcome === "waiting" ? (oldest?.id ?? null) : null);
      // Both writes after the answer and with no await between them, so no
      // batch can land in the middle of them: an event needs a task boundary
      // and there is none here.
      useAppStore.getState().prependHistory(key, older, more);
      if (armed) useAppStore.getState().setAskedBehind(key, oldest?.id ?? null);
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

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    // The anchor putting the pane back, telling the virtualiser so. It has
    // recorded the reader's place itself, and everything below would read this
    // as the reader having moved: the follow state, the row the pane is
    // remembered at, and whether to ask for another page.
    if (raisedByAnchor(event.nativeEvent)) return;
    // Every write to `scrollTop` raises one of these, whoever made it — the
    // reader's wheel, the anchor, and the virtualiser correcting for a row it
    // has just measured. A pane that moves with nothing in this trace moved
    // because its content did.
    probe("scroll", { view, top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight });
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
  loading: boolean,
): string | null {
  if (loadError !== null) return loadError;
  if (loading) return "Loading older messages";
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
