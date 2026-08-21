import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { probe, probing } from "@/lib/probe";

/** The part of the head element this module reads. */
export interface Head {
  readonly offsetHeight: number;
}

/**
 * What the virtualiser is asked. Both answers are in the scroller's own
 * coordinates — but with the head counted at the `margin` below rather than at
 * the height it has, which is the same number on every commit except the one it
 * arrives or leaves in. Comparing either with `scrollTop` means going through
 * that difference.
 */
export interface Offsets {
  /** Where the row holding a message starts, or undefined if it is not there. */
  offsetOfMessage: (id: string) => number | undefined;
  /** A message in the row under an offset, or undefined above the first row. */
  messageAtOffset: (offset: number) => string | undefined;
  /**
   * How far into its row a message's own line is drawn, and undefined where the
   * row is not on the screen to be measured.
   *
   * A row is a run of messages, so this is not always zero and does not always
   * stay what it was: a landing page can merge into the block at the top of the
   * window, putting the messages it brought above the reader's own line inside
   * the row that holds it (#535).
   */
  lineWithinRow: (id: string) => number | undefined;
  /**
   * Whether the row holding a message is a height the virtualiser has not been
   * told about, and false where the row is not on the screen to compare.
   *
   * A row the virtualiser is still carrying an estimate for is a `scrollTop`
   * write that has not happened yet: the correction comes on the commit that
   * measures it, and a row starting above the fold is compensated for in full
   * — including the part of it drawn *below* the fold, which is content the
   * reader is not sitting on top of. A block that has just taken a page in is
   * that row and the reader is inside it, so the write is the whole of what the
   * page added above their line (#535's shape in the pane that did not ask).
   */
  rowUnmeasured: (id: string) => boolean;
}

/**
 * The scroll events this module raises, which are the pane being put back
 * rather than the reader moving it.
 *
 * They are for the virtualiser, which has no other way to hear about an
 * assignment to `scrollTop` — see `place` below. Everything in this app that
 * answers a scroll has already been answered by the effect that raised it, so
 * the handler asks this and stands down. The browser's own event for the same
 * assignment arrives a frame later, is not in here, and is handled as any other.
 */
const raised = new WeakSet<Event>();

/** Whether this is one of ours. */
export function raisedByAnchor(event: Event): boolean {
  return raised.has(event);
}

/** Where the reader is: a message, where its row sat under their eyes, and the
 * place it held in the list when that was read. */
interface Anchor {
  id: string;
  delta: number;
  index: number;
  /** How far into that row the message's own line was drawn, or null where the
   * row was not on the screen to measure. Held so that a row which takes in
   * messages above the reader can be told from one that did not (#535). */
  within: number | null;
}

interface Committed {
  firstId: string | null;
  headPx: number;
  /** The container's height last commit, which is how a hold knows whether the
   * rows above the reader are still measuring. Only ever compared for equality
   * — #477 is what reading a position out of it costs. */
  sh: number;
}

/**
 * True when the reader's own message is still in the list at a different place
 * in it, which is the whole of what displaces them: something arriving in front
 * of it moves it down, the window dropping its oldest moves it up, and a message
 * arriving behind them moves it not at all.
 *
 * The index it held is checked before the list is searched, so the common case —
 * nothing above the reader changed — is a lookup rather than a scan.
 *
 * Still in the list is what tells a shift from a target switch, which replaces
 * every message and must not be answered by scrolling.
 *
 * Messages rather than rows: a page can merge into the group that was at the
 * top, which changes that row's identity but not any message's.
 */
export function movedInList(
  messages: readonly { id: string }[],
  held: Pick<Anchor, "id" | "index">,
): boolean {
  if (messages[held.index]?.id === held.id) return false;
  return messages.some((message) => message.id === held.id);
}

/**
 * Holds the viewport still when the list changes in front of the reader, and
 * when the head above it comes and goes.
 *
 * Paging history in is the case that built this and it is not the only one: a
 * server that stamps a message behind what is already held sorts it in where it
 * belongs, and the window at its cap drops its oldest to make room. All three
 * put a different amount of list above the reader than they were reading
 * against, which is why the trigger is the reader's own message moving rather
 * than the first one changing.
 *
 * The move is answered by putting that message back where the reader had it,
 * rather than by adding the container's growth to `scrollTop`. The growth is
 * not knowable on this commit and the position is: the DOM at layout time is
 * the render the virtualiser has already superseded — its sizer is still the
 * height estimated for rows that have since been measured, and reading
 * `scrollHeight` corrected for the estimate rather than for the page that
 * landed, by 228px of a 100-message page (#477). The virtualiser's own
 * measurements are current by the time this runs, so its offsets are asked
 * instead, and an offset cannot be wrong about an estimate the way a height
 * difference can.
 *
 * Absolute rather than relative for a second reason. The virtualiser corrects
 * `scrollTop` itself for rows it measures above the fold, in the ref callbacks
 * of this same commit, so by the time a layout effect runs, part of the growth
 * has already been paid for. Anything adding a delta pays it twice; a position
 * subsumes it.
 *
 * Asserted again on the commits after, because the offsets are current on the
 * landing commit and the DOM is not: the rows are still transformed to where
 * the superseded render put them, so the frame that paints is short by whatever
 * was measured between the two. That second assertion is what the doubled-
 * estimate control needs — 46px to 92px leaves the landing at 0.0 with it and
 * -102 without.
 *
 * **It is held until the measuring stops rather than spent on one commit**, and
 * #532 is the difference. A page of two hundred rows is measured over the
 * commits that follow it — fourteen of them in end-to-end run 30, two to three
 * milliseconds apart and inside one frame — and a single second pass answers
 * the first of them and leaves the rest to move the reader.
 *
 * Which commit moves them cannot be guessed at. Thirteen of those fourteen
 * measured rows *below* the reader and asked nothing of the anchor; the
 * fourteenth measured one above and moved them 11px. So a hold that ends the
 * first time the pane looks right ends twelve commits early, which is what the
 * first attempt at this did and why it changed nothing a walk could see.
 *
 * What ends it is the container's height standing still between two commits
 * *and* the reader's own row being a height the virtualiser knows: the rows have
 * stopped measuring and there is no correction still owed for the one the reader
 * is inside. A height that stands still is not the measuring being over on its
 * own — a row remounted under a new key is measured a commit or more later than
 * the rows around it, and a block that has just merged a page into itself is
 * remounted under a new key by definition. Also the list changing again, which
 * means this hold's landing is over and anything that moves the reader now — a
 * live message arriving, the window dropping its oldest, the pane following its
 * tail — is a fresh event that arms its own; and the reader's message going,
 * which is a target switch.
 *
 * What it can no longer do is read a changed `scrollTop` as the reader: during
 * settling the virtualiser moves the pane on purpose, and that is the thing
 * being corrected for. The reader is told by `release`, on the wheel, pointer
 * and key `Timeline` already stands the restore down on.
 *
 * The head is inside the scroller, so it displaces every row below it when it
 * arrives — and it arrives on a commit that changes no message's place, where
 * `movedInList` is false and the growth above the viewport is nobody's business
 * (#475). Its departure needs no term of its own: it leaves on the commit that
 * prepends the page, where the offsets on both sides are measured from the top
 * of the scroller and carry it.
 *
 * Measured off the element rather than taken from the height Timeline keeps in
 * state for the virtualiser's `scrollMargin`: that state is a commit behind the
 * DOM, and this runs on the commit the head lands in.
 *
 * Which is why `margin` is asked for as well as the element. The offsets are
 * measured from the top of the scroller with that margin standing in for the
 * head, so on the one commit where the head is in the DOM and the margin does
 * not know it yet — or the other way round, which is where a page lands — the
 * answers are a head's height from where the rows are drawn. Everything here
 * reads them through that difference, which is zero on every other commit. The
 * pass below corrected it a commit later and only while nothing else moved the
 * pane; #508 is the landings where something did.
 *
 * Returns two things the pane has to call. `record` is the reader's position,
 * for the scroll handler: the page lands a round trip after the scroll that
 * asked for it, so a position recorded on the last commit is however far the
 * reader has read since. `release` is the reader taking the pane over, for the
 * wheel, pointer and key handlers.
 *
 * `view` names the pane in the records `@/lib/probe` writes, which are nothing
 * in a build that did not ask for them.
 */
export function usePrependAnchor(
  ref: RefObject<HTMLElement | null>,
  head: RefObject<Head | null>,
  messages: readonly { id: string }[],
  offsets: Offsets,
  margin: number,
  view: string,
): { record: () => void; release: () => void } {
  const committed = useRef<Committed | null>(null);
  const anchor = useRef<Anchor | null>(null);
  /** The reader the landing put back, held while the rows above them are still
   * measuring, with the length of the list it was taken against. Cleared by the
   * commit that finds the measuring over, and by the reader taking the pane
   * over. */
  const settling = useRef<(Anchor & { count: number }) | null>(null);
  // Read by `record` between commits, where the rows and messages they close
  // over are the ones last rendered. Nothing changes either without a commit to
  // assign it.
  const latest = useRef(offsets);
  const rendered = useRef(messages);
  // What an offset is out by, which is the head the DOM has less the head the
  // offsets were measured against.
  const lag = useRef(0);

  const record = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const id = latest.current.messageAtOffset(el.scrollTop - lag.current);
    const start = id === undefined ? undefined : latest.current.offsetOfMessage(id);
    anchor.current =
      id === undefined || start === undefined
        ? null
        : {
            id,
            delta: start + lag.current - el.scrollTop,
            index: rendered.current.findIndex((message) => message.id === id),
            within: latest.current.lineWithinRow(id) ?? null,
          };
  }, [ref]);

  useLayoutEffect(() => {
    latest.current = offsets;
    rendered.current = messages;
    const el = ref.current;
    if (!el) return;
    const previous = committed.current;
    const first = messages[0]?.id ?? null;
    const headPx = head.current?.offsetHeight ?? 0;
    lag.current = headPx - margin;
    /** Where a message is drawn, from an offset measured against the margin. */
    const drawnAt = (id: string) => {
      const start = offsets.offsetOfMessage(id);
      return start === undefined ? undefined : start + lag.current;
    };
    /**
     * What the row under the reader has taken in above their own line since the
     * anchor was taken, which the row's own top cannot say (#535): a page that
     * merges into the block at the top of the window leaves the reader's
     * message second in a run it opened, that far below where the row starts.
     *
     * Zero where either side is unmeasured, which is the row not being on the
     * screen — and on the commit a page lands in it usually is not, the rendered
     * window being the one the old scroll offset asked for. That is not a
     * failure to correct: the hold below runs again on the commits after, where
     * the row is drawn and this answers.
     */
    const tookIn = (held: Anchor) => {
      const now = offsets.lineWithinRow(held.id);
      return held.within === null || now === undefined ? 0 : now - held.within;
    };
    /**
     * Puts the pane there, and sends the scroll event a browser would send a
     * frame from now.
     *
     * Everything else that moves this scroller computes from the last scroll it
     * heard about, and the virtualiser above all: it keeps its own copy of
     * `scrollTop`, refreshes it only in that listener, and adds the correction
     * for a row it has just measured to whatever the copy says. A correction
     * landing between an assignment here and the browser's own event is
     * therefore added to where the pane was *before* this ran, and discards
     * what this wrote.
     *
     * #508 is those landings, and it is why the shift is always exactly one
     * head's height: the head arrives, the branch below adds it, a row above
     * the fold is measured a moment later, and the correction takes it away
     * again. Measured 6 times in 100 landings in end-to-end run 24, against 145
     * arrivals where nothing wrote in that window and the reader held.
     *
     * The event the browser sends afterwards costs nothing: the position it
     * reports is the one this already told it about.
     */
    const place = (top: number) => {
      el.scrollTop = top;
      const event = new Event("scroll");
      raised.add(event);
      el.dispatchEvent(event);
    };
    const reader = anchor.current;
    const before = el.scrollTop;
    let branch = "none";
    if (previous && reader !== null && movedInList(messages, reader)) {
      branch = "moved";
      const start = drawnAt(reader.id);
      if (start !== undefined) place(start + tookIn(reader) - reader.delta);
      settling.current = { ...reader, count: messages.length };
    } else if (settling.current !== null) {
      const held = settling.current;
      const start = drawnAt(held.id);
      // What ends the hold, and none of the three is "the pane looks right on
      // this commit": it looked right on eleven of the fourteen that #532 was
      // measured over, and the drift arrived on the twelfth.
      //
      //   - the message is gone, which is a target switch and not this reader;
      //   - the list changed again under it, so whatever this hold was taken
      //     for is over — a live message arriving, the window dropping its
      //     oldest, the pane following its tail. A landing that moved the
      //     reader takes the branch above and arms a hold of its own;
      //   - the container stopped growing *and* the reader's row is the height
      //     the virtualiser has for it, which is the measuring finishing and is
      //     the ordinary way out. Both halves are needed: the row a page merged
      //     into is remounted under a key nothing has measured, so its own
      //     correction lands after the height has already stood still once.
      //
      // **A pane that is not where this would put it is corrected first, and
      // #535 is why the order matters.** What the reader's row took in can only
      // be read once that row is drawn, and on the commit a page lands in it is
      // not: the rendered window there is the one the *old* scroll offset asked
      // for. The term arrives on the commit after — the same commit the height
      // stops changing on — so a hold that reads the ending first ends one
      // commit before the only measurement that could have answered it, which
      // is what a walk of this fix found it doing.
      const gone = start === undefined || messages.length !== held.count;
      const target = start === undefined ? 0 : start + tookIn(held) - held.delta;
      if (!gone && Math.abs(el.scrollTop - target) > 1) {
        branch = "settling";
        place(target);
        // Somewhere the scroller will not go — clamped at either end — is not
        // a hold worth keeping: it would be asserted again on every commit for
        // the rest of the conversation.
        if (Math.abs(el.scrollTop - target) > 1) settling.current = null;
      } else if (gone || (el.scrollHeight === previous?.sh && !offsets.rowUnmeasured(held.id))) {
        branch = "settled";
        settling.current = null;
      } else {
        // Held, and this commit asked nothing of it. Named rather than left as
        // `none` because the two are the difference between an anchor that is
        // watching and one that has gone home, and a walk reads these back.
        branch = "holding";
      }
    } else if (previous && previous.firstId === first && headPx !== previous.headPx) {
      branch = "head";
      place(el.scrollTop + (headPx - previous.headPx));
    }
    committed.current = { firstId: first, headPx, sh: el.scrollHeight };
    record();
    // After `record`, so `now` is the message under the reader's eyes on the
    // frame this commit paints and `held` is the one it was before. Where they
    // are the same message and its `delta` has changed, the pane moved without
    // anything here writing to it — which is the half of #508 a screenshot
    // cannot tell from the other.
    //
    // The rest of this effect is records. `probe` is a branch a build without
    // the probe drops, but the record handed to it is an argument and an
    // argument is evaluated either way, so a reading of the DOM has to be
    // skipped here rather than there.
    if (!probing) return;
    probe("commit", {
      view,
      // Which pane this is, in the only terms a screenshot shares: a view id is
      // arbitrary and the walk knows the panes by where they are.
      x: Math.round(el.getBoundingClientRect().left),
      msgs: messages.length,
      first,
      branch,
      headPx,
      margin,
      before,
      top: el.scrollTop,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      held: reader,
      drawn: reader === null ? null : (drawnAt(reader.id) ?? null),
      // What the reader's row took in above them, which is a term of the write
      // and is otherwise invisible in these records.
      tookIn: reader === null ? null : tookIn(reader),
      now: anchor.current,
      // Where the reader's line is drawn, which the terms above give only as
      // the virtualiser's own arithmetic. The stack records carry this around a
      // landing and a landing is where it is least worth having: the rendered
      // window on that commit is the one the old scroll offset asked for. A
      // reading from *before* the page arrived is what says whether anybody
      // moved, and only a record on every commit has one (#601).
      line: lineOf(el, settling.current?.id ?? anchor.current?.id),
      // And where the message the reader is *looking at* is drawn, which in
      // this arrangement is a different message a screen or more below.
      fold: lineOf(el, atFold(el)),
    });
    // Who the reader is, which only the landing commit is asked for: the
    // message the hold was just taken on, or the one under them where the
    // landing armed no hold.
    probeStack(view, el, first !== (previous?.firstId ?? null), settling.current?.id ?? anchor.current?.id);
    // After the records, so a landing latches the fold this pane had on the
    // commit before it.
    latch(wasAtFold, el, atFold(el));
  });

  /** The reader has taken the pane over, so stop putting it back. The same
   * signal the restore stands down on and for the same reason: a wheel, a
   * pointer or a key is the reader, and an assignment to `scrollTop` is not. */
  const release = useCallback(() => {
    settling.current = null;
  }, []);

  return { record, release };
}

/**
 * How many commits of the stack a landing is worth recording. A landing is not
 * one commit: the page arrives, the rows above the reader are measured over the
 * commits after it, and the offsets the virtualiser computes from those
 * measurements are what #601 and #602 are about. Four is what the anchor's own
 * records already show a landing settling in.
 */
const STACK_COMMITS = 8;
/** Commits of the stack still owed, per scroller. */
const owed = new WeakMap<HTMLElement, number>();
/**
 * The message a pane's records are read against, taken on the landing commit
 * and kept for the commits owed after it.
 *
 * Latched rather than asked for each time, because what the anchor names stops
 * being the reader the moment they are displaced: the hold ends, the next
 * `record` names whatever the pane is now sitting on, and a before-and-after
 * loses the message it was about halfway through (#601). The reader the page
 * arrived under is the subject of the whole window.
 */
const reading = new WeakMap<HTMLElement, string>();
/**
 * The message the reader was looking at when the page arrived, and the one each
 * pane had at its fold on the commit before.
 *
 * Two maps because the landing commit cannot be asked: the rendered window
 * there is the one the old scroll offset asked for, so what is drawn at the top
 * of the pane on that commit is not what anybody was reading. The commit before
 * it is.
 */
const wasAtFold = new WeakMap<HTMLElement, string>();
const watching = new WeakMap<HTMLElement, string>();

/** Latches a message for the length of a landing's window, or forgets the one
 * before where this landing has nobody to name. */
function latch(map: WeakMap<HTMLElement, string>, el: HTMLElement, id: string | undefined): void {
  if (id === undefined) map.delete(el);
  else map.set(el, id);
}

/**
 * Every row the pane draws, as the virtualiser placed it and as the browser
 * measures it.
 *
 * #602 is a block drawing a run of its messages nowhere on the screen, and what
 * a walk cannot answer is whether the row's own height is wrong or the transform
 * it was placed at is — a release build has no DOM anybody can ask. Both are
 * here on the same line, so they are told apart by subtraction: a stack whose
 * every row starts where the one above it ends is a pane whose arithmetic is
 * right, and a defect still on the screen after that is paint.
 *
 * Only around a landing. On every commit this is twenty rows a commit for the
 * length of a walk, which is a record nobody reads and a cost on the commits
 * being measured.
 */
/** From the top of a row's first message to the bottom of its last, which is
 * what the row would be the height of if every message in it took its own
 * space. */
function spannedBy(row: HTMLElement): number {
  const lines = [...row.querySelectorAll<HTMLElement>("[data-msgid]")];
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return 0;
  return Math.round(last.getBoundingClientRect().bottom - first.getBoundingClientRect().top);
}

/**
 * The row's messages by the number the seed wrote into them, and how many
 * places that run is not consecutive at.
 *
 * The frames of #602 show a block drawing `line 0600` and then `line 0611`, and
 * every measurement so far — the row's height, what its messages span, how many
 * it holds — says the row is whole. What none of them reads is the *order* the
 * messages are in inside it, which is the difference between an engine drawing
 * the wrong thing and this app handing it one.
 */
function numbering(row: HTMLElement): { from: number; to: number; jumps: number; run: string } {
  const nums = [...row.querySelectorAll<HTMLElement>("[data-msgid]")]
    .map((line) => Number(/line (\d{4})/.exec(line.textContent ?? "")?.[1] ?? Number.NaN))
    .filter((n) => !Number.isNaN(n));
  let jumps = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1]! + 1) jumps++;
  // The run itself where it is not consecutive, as the ends of its stretches:
  // "600-601 611-619 602-610" is a different bug from "600-659 with one line
  // repeated", and a count cannot tell them apart.
  const stretches: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    const start = nums[i]!;
    while (i + 1 < nums.length && nums[i + 1] === nums[i]! + 1) i++;
    stretches.push(start === nums[i] ? `${start}` : `${start}-${nums[i]}`);
  }
  return { from: nums[0] ?? 0, to: nums.at(-1) ?? 0, jumps, run: stretches.join(" ") };
}

/**
 * Where the virtualiser put a row. The transform rather than a rect: it is the
 * number the virtualiser wrote, and a rect would fold the scroll offset back
 * into it.
 */
function rowTop(row: HTMLElement): number {
  return Math.round(Number.parseFloat(row.style.transform.replace(/[^-\d.]/g, "")) || 0);
}

/**
 * The highest of these drawn at or across an edge. The virtualiser's rows are
 * in the DOM in the order it rendered them rather than the order it placed
 * them, and this does not depend on either.
 */
function topmostAt(elements: HTMLElement[], edge: number): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  let best = Infinity;
  for (const candidate of elements) {
    const box = candidate.getBoundingClientRect();
    if (box.bottom > edge && box.top < best) {
      best = box.top;
      found = candidate;
    }
  }
  return found;
}

/**
 * The message at the top of the pane, which is the one the reader is looking
 * at.
 *
 * `lineOf` below is asked where the *anchor's* message is drawn, and the two
 * are not the same message: the anchor names the first message of the row under
 * the scroll offset, and where that row is a run of sixty it can start a screen
 * or more above the fold. A page merging into that row below the anchor's
 * message and above this one moves everything the reader can see while every
 * term the anchor computes reads held — which is #601, and is why a record
 * carrying only the anchor's line cannot tell a reader who held from one who
 * was displaced.
 *
 * The rows are asked first and the messages only of the rows that answer: a
 * window of twenty rows of sixty is twelve hundred lines, and this runs on
 * every commit. Rows rather than row, because the one at the top of the pane
 * need not hold a message at all — a date or an unread seam is a row, and the
 * reader is looking at whatever is under it.
 */
function atFold(el: HTMLElement): string | undefined {
  const edge = el.getBoundingClientRect().top;
  const rows = [...el.querySelectorAll<HTMLElement>("[data-index]")]
    .filter((row) => row.getBoundingClientRect().bottom > edge)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  for (const row of rows) {
    const line = topmostAt([...row.querySelectorAll<HTMLElement>("[data-msgid]")], edge);
    if (line) return line.dataset.msgid;
  }
  return undefined;
}

/**
 * Where the reader's own line is drawn, named by the message rather than by the
 * row that holds it (#601).
 *
 * A page merging into the reader's block gives that row a new key and re-orders
 * what is inside it, so two records of the stack cannot be compared row by row
 * across a landing: the same `i` is not the same row and the same row is not the
 * same messages. An id survives both. `within` and `top` are the two halves of
 * where the list puts the line, which is what tells a reader who moved from a
 * row re-ordered under one who did not; `y` is where it is against the top of
 * the pane, which is the number the walk was reading off a screenshot.
 */
function lineOf(
  el: HTMLElement,
  id: string | undefined,
): { id: string; i: number; within: number; top: number; y: number } | null {
  if (id === undefined) return null;
  // Compared rather than selected on, for `lineWithinRow`'s reason: an id is
  // the server's or this client's and neither is written to be a selector.
  const line = [...el.querySelectorAll<HTMLElement>("[data-msgid]")].find(
    (candidate) => candidate.dataset.msgid === id,
  );
  const row = line?.closest<HTMLElement>("[data-index]");
  if (!line || !row) return null;
  const at = line.getBoundingClientRect().top;
  return {
    id,
    i: Number(row.dataset.index),
    within: Math.round(at - row.getBoundingClientRect().top),
    top: rowTop(row),
    y: Math.round(at - el.getBoundingClientRect().top),
  };
}

function probeStack(view: string, el: HTMLElement, landed: boolean, reader: string | undefined): void {
  const left = landed ? STACK_COMMITS : (owed.get(el) ?? 0);
  if (left <= 0) return;
  owed.set(el, left - 1);
  if (landed) {
    latch(reading, el, reader);
    latch(watching, el, wasAtFold.get(el));
  }
  const rows = [...el.querySelectorAll<HTMLElement>("[data-index]")].map((row) => ({
    i: Number(row.dataset.index),
    // What the messages inside the row take up, against the height the row
    // measured. #602's frames show ten messages absent from a row whose height
    // counts them, and a count of `[data-msgid]` elements cannot tell a message
    // the engine failed to paint from one laid out with no height at all.
    spanned: spannedBy(row),
    ...numbering(row),
    zero: [...row.querySelectorAll<HTMLElement>("[data-msgid]")].filter(
      (line) => line.offsetHeight === 0,
    ).length,
    top: rowTop(row),
    h: row.offsetHeight,
    first: row.querySelector<HTMLElement>("[data-msgid]")?.dataset.msgid ?? null,
    last: [...row.querySelectorAll<HTMLElement>("[data-msgid]")].at(-1)?.dataset.msgid ?? null,
    says: row.querySelectorAll("[data-msgid]").length,
  }));
  probe("stack", {
    view,
    x: Math.round(el.getBoundingClientRect().left),
    landed,
    top: el.scrollTop,
    // Where the reader is, by message. The rows below are the pane's own
    // arithmetic; these are the place in it the walk is asking about (#601) —
    // the message the anchor is holding, and the message the reader had at the
    // top of the pane when the page arrived.
    line: lineOf(el, reading.get(el)),
    fold: lineOf(el, watching.get(el)),
    rows,
  });
}
