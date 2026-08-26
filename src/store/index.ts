import { create } from "zustand";
import { SECTIONS, type SectionId } from "@/components/settings/sections";
import {
  DEFAULT_DENSITY,
  DEFAULT_PRESENTATION,
  DEFAULT_TYPOGRAPHY,
  FALLBACK_THEME_ID,
  type Catalogue,
  type DensityId,
  type Overrides,
  type Presentation,
  type Typography,
} from "@/lib/theme";
import {
  SERVER_TARGET,
  type ChatMessage,
  type InstalledPlugin,
  type IrcxEvent,
  type Member,
  type Reaction,
} from "@/types";
import { networkPrefix, sameTarget, targetKey, type TargetKey } from "./keys";
import {
  fromStored,
  openStored,
  paneOrder,
  removeLeaf,
  setRatio,
  splitLeaf,
  type SplitPath,
} from "./layout";
import type {
  ActiveTarget,
  AppState,
  ChatView,
  ConsoleInput,
  IrcLinkSetup,
  Layout,
  SearchMode,
  SplitDirection,
  SidebarFilter,
  StoredLayout,
  TimelineState,
  ViewId,
} from "./types";

/** Older messages stay in SQLite; the window is what the timeline can scroll.
 * Paging backwards stops at the same figure, because the size the window is
 * meant to be is one answer and not two (#331). Four thousand leaves one
 * archive page above the largest burst walked in WebKit (about 3,800). */
const TIMELINE_CAP = 4_000;
const RAW_LOG_CAP = 2_000;
const RECENT_CAP = 50;
/** Per conversation, and only for this run — nothing here is written to disk. */
const INPUT_HISTORY_CAP = 100;

const EMPTY_TIMELINE: TimelineState = {
  messages: [],
  unreadFrom: null,
  readMarker: null,
  hasMore: true,
  loadingOlder: false,
  askedBehind: null,
  detachedAt: null,
};

/** Sequential rather than random so a test can name the view it just opened. */
let nextViewId = 0;
function mintViewId(): ViewId {
  nextViewId += 1;
  return `view-${nextViewId}`;
}

export interface AppActions {
  applyEvent: (event: IrcxEvent) => void;
  /** A window's worth of events in one write. The backend delivers them
   * together; applying them one at a time would render once per event, which is
   * what made a `LIST` sluggish after the raw log stopped freezing — #119. */
  applyEvents: (events: IrcxEvent[]) => void;

  /** Points the focused view at a target, opening a view if none exists. */
  setActive: (target: ActiveTarget | null) => void;
  /** Takes the user to a target: focuses a pane already showing it, and only
   * retargets the focused pane when none is. */
  showTarget: (target: ActiveTarget) => void;
  /** Points the focused view at a network's console, showing either what the
   * server said or the protocol log. */
  openConsole: (network: string, raw?: boolean) => void;
  prependHistory: (key: TargetKey, older: ChatMessage[], hasMore: boolean) => void;
  replaceHistory: (key: TargetKey, messages: ChatMessage[]) => void;
  /** Why the window could not read its own data, or null once it could. */
  setStartupFailure: (reason: string | null) => void;
  clearBuffer: (key: TargetKey) => void;
  setLoadingOlder: (key: TargetKey, loading: boolean) => void;
  /** Records the message the server has been asked for the page behind, so the
   * next scroll can tell its own request from the one already out (#487). */
  setAskedBehind: (key: TargetKey, msgid: string | null) => void;
  clearUnreadMarker: (key: TargetKey) => void;

  setViewAnchor: (view: ViewId, row: string | null) => void;
  setMessageJump: (view: ViewId, message: string | null) => void;
  /** Asks a pane to return to the live edge, or takes the request back once it
   * has. Not `setViewAnchor(view, null)`: the anchor is what a pane writes as it
   * scrolls, and asking through it would be answering its own reports. */
  setLatestJump: (view: ViewId, wanted: boolean) => void;
  setViewSelectedUser: (view: ViewId, nick: string | null) => void;
  setViewRaw: (view: ViewId, raw: boolean) => void;
  /** Holds one console pane's command box. Both fields together: sending clears
   * the text and the refusal at once, and a refusal puts the text back. */
  setConsoleInput: (view: ViewId, input: ConsoleInput) => void;
  /** Parks where one pane is reading the protocol log, or `null` for the tail. */
  setRawAnchor: (view: ViewId, line: number | null) => void;
  /** Holds why one pane's last line was refused, or clears it with null. */
  setComposerError: (view: ViewId, reason: string | null) => void;

  /** Opens a second pane on the focused view's target and focuses it. */
  splitActiveView: (direction: SplitDirection) => void;
  /** Refused for the last pane; the window always holds at least one. */
  closeView: (view: ViewId) => void;
  focusView: (view: ViewId) => void;
  /** Opens settings over the layout, or moves the open one to `section`.
   * Defaults to the first section. */
  openSettings: (section?: SectionId) => void;
  closeSettings: () => void;
  /** Moves open settings to another section, for its own sidebar. */
  setSettingsSection: (section: SectionId) => void;
  /** Moves one split's divider. `path` names the split by the route to it from
   * the root, which is what the component drawing the divider holds. */
  setSplitRatio: (path: SplitPath, ratio: number) => void;
  /** Opens the panes a previous run left, dropping any whose conversation the
   * client no longer holds. Called once, after the snapshot says what exists. */
  restoreLayout: (stored: StoredLayout) => void;

  /** Stages the message the next line in this conversation answers, or clears
   * it with a null msgid. */
  setReplyTo: (network: string, target: string, msgid: string | null) => void;

  /** Records a line as sent in this conversation, for the composer to recall. */
  rememberInput: (network: string, target: string, text: string) => void;
  setDraftPresence: (network: string, target: string, present: boolean) => void;
  setBookmarked: (network: string, target: string, message: string, active: boolean) => void;

  /** Hides or shows one pane's member list, leaving every other pane alone. */
  toggleRoster: (view: ViewId, shown?: boolean) => void;
  /** Narrows one pane's roster, or closes the filter with null. `""` opens an
   * empty one. */
  setMemberFilter: (view: ViewId, text: string | null) => void;
  togglePalette: (open?: boolean) => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openSearch: (mode?: SearchMode) => void;
  closeSearch: () => void;
  /** Opens settings on the Networks page, showing one network's form — or a
   * blank one for a null id. */
  openSetup: (network: string | null) => void;
  openIrcSetup: (link: IrcLinkSetup) => void;
  /** Back to the list of networks, which is the form's way out. */
  closeSetup: () => void;
  /** Hands picked files to the upload confirmation, or clears them once it has
   * them. An empty list is nothing to confirm and clears it too. */
  setUploadRequest: (paths: string[] | null) => void;
  /** Shows the channel list a network answered, or puts it away. */
  showChannels: (network: string | null) => void;
  browseChannels: (network: string) => void;
  /** The words that raise a conversation beside the reader's nickname. Held
   * here rather than fetched where they are used: the timeline asks the
   * question once per message, and the answer is one round trip per launch. */
  setHighlightWords: (words: string[]) => void;
  setHushedNicks: (nicks: string[]) => void;
  setPlugins: (plugins: InstalledPlugin[]) => void;
  /** Records that the library could not be read at all. */
  setPluginsUnavailable: (reason: string) => void;
  /** Replaces the entry with this id, or adds it. Both `install_plugin` and
   * `set_plugin_grants` answer with the whole plugin, so nothing has to be
   * read back to keep the list right. */
  upsertPlugin: (plugin: InstalledPlugin) => void;
  dropPlugin: (plugin: string) => void;
  toggleNetworkCollapsed: (network: string) => void;
  setSidebarWidth: (px: number) => void;
  setSidebarCompact: (compact: boolean) => void;
  setSidebarFilter: (filter: SidebarFilter) => void;
  togglePinnedTarget: (target: TargetKey) => void;
  /** Null gives the column back to the names in it. */
  setRosterWidth: (px: number | null) => void;

  setThemeCatalogue: (catalogue: Catalogue) => void;
  setThemeId: (id: string) => void;
  setDensity: (id: DensityId) => void;
  setPresentation: (next: Presentation) => void;
  setTypography: (next: Typography) => void;
  /** The whole record rather than one token, because an edit is committed in
   * three places — the window, localStorage and here — and the three have to
   * be given the same thing. */
  setOverrides: (next: Overrides) => void;
}

const initialState: AppState = {
  networks: {},
  networkOrder: [],
  channels: {},
  queries: {},
  transfers: {},
  startupFailure: null,
  members: {},
  timelines: {},
  typing: {},
  ignored: {},
  replyTo: {},
  inputHistory: {},
  drafts: {},
  bookmarks: {},
  rawLog: {},
  channelList: {},
  views: {},
  viewAnchor: {},
  messageJump: {},
  latestJump: {},
  consoleInput: {},
  rawAnchor: {},
  composerError: {},
  viewOrder: [],
  activeViewId: null,
  layout: null,
  settings: null,
  recent: [],
  rosterHidden: {},
  memberFilter: {},
  paletteOpen: false,
  shortcutsOpen: false,
  searchOpen: false,
  searchMode: "search",
  setup: null,
  uploadRequest: null,
  channelsOpen: null,
  highlightWords: [],
  hushedNicks: [],
  plugins: [],
  pluginsUnavailable: null,
  collapsedNetworks: {},
  sidebarWidth: 240,
  sidebarCompact: false,
  sidebarFilter: null,
  pinnedTargets: [],
  rosterWidth: null,
  themes: [],
  brokenThemes: [],
  themeId: FALLBACK_THEME_ID,
  density: DEFAULT_DENSITY,
  presentation: DEFAULT_PRESENTATION,
  typography: DEFAULT_TYPOGRAPHY,
  overrides: {},
};

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  ...initialState,

  applyEvent: (event) => set((s) => reduce(s, event)),

  applyEvents: (events) =>
    set((s) => {
      let next = s;
      // A netsplit is thousands of roster changes interleaved with the messages
      // reporting them, and each one rebuilt the whole member list: n people
      // leaving a channel of n cost n²/2 element copies, 134 ms at n = 2,500
      // (#321). Held as nick to member while the batch runs, each costs one
      // lookup and the list is rebuilt once.
      //
      // This is a second implementation of what `reduce` does for one event.
      // `reduce` is the one to trust; `index.test.ts` asserts this agrees with
      // it over a batch built to make them disagree.
      const rosters = new Map<TargetKey, Map<string, Member>>();

      const flushRosters = () => {
        if (rosters.size === 0) return;
        const members = { ...next.members };
        for (const [key, roster] of rosters) members[key] = [...roster.values()];
        next = { ...next, members };
        rosters.clear();
      };

      // The messages reporting the same netsplit cost the same shape (#325):
      // `mergeByTime` builds a new list per event, so a thousand arriving as a
      // thousand events is a thousand copies of a list growing to a thousand.
      // Held as one list the batch extends, that is one copy.
      //
      // Only the merge is deferred. The unread seam is still answered as each
      // event lands, because a batch can close the channel a pane was reading
      // and because a line you sent does not open a seam but does not stop the
      // answer to it from opening one — and where the reader stopped is the
      // thing #223 says people notice being wrong.
      const timelines = new Map<TargetKey, HeldTimeline>();

      const flushTimelines = () => {
        if (timelines.size === 0) return;
        const held = { ...next.timelines };
        for (const [key, timeline] of timelines) {
          // Capped here rather than per event. It is the same newest window
          // either way; what differs is that an echo of a message the cap would
          // have dropped mid-batch is still recognised as one.
          held[key] = {
            ...(next.timelines[key] ?? EMPTY_TIMELINE),
            messages: capped(timeline.messages),
            unreadFrom: timeline.unreadFrom,
            askedBehind: timeline.askedBehind,
            hasMore: timeline.hasMore,
          };
        }
        next = { ...next, timelines: held };
        timelines.clear();
      };

      // The raw log is the shape #321 fixed for rosters, unfixed until every
      // line of a `/list` went through `reduce` one at a time: each copied a
      // log of up to 2,000 entries, tens of millions of element copies in one
      // batch. Held as the batch's new lines and joined to the log once.
      const rawLines = new Map<string, string[]>();

      const flushRawLines = () => {
        if (rawLines.size === 0) return;
        const rawLog = { ...next.rawLog };
        for (const [network, lines] of rawLines) {
          const joined = [...(rawLog[network] ?? []), ...lines];
          rawLog[network] =
            joined.length > RAW_LOG_CAP ? joined.slice(-RAW_LOG_CAP) : joined;
        }
        next = { ...next, rawLog };
        rawLines.clear();
      };

      for (const event of events) {
        const roster = rosterFor(event, next, rosters);
        if (roster !== undefined) {
          applyRoster(roster, event as RosterEvent);
          continue;
        }
        if (event.type === "messagesAppended") {
          holdMessages(event, next, timelines);
          continue;
        }
        if (event.type === "rawLine") {
          const line = `${event.outgoing ? ">>" : "<<"} ${event.line}`;
          const held = rawLines.get(event.network);
          if (held) held.push(line);
          else rawLines.set(event.network, [line]);
          continue;
        }
        // `networkRemoved` is the only reducer other than the roster three that
        // reads `members`, so what has not been written back yet must land
        // before it runs — otherwise this batch writes a roster back over a
        // network the same batch deleted.
        //
        // Timelines have no such single reader: a rename moves one, a redaction
        // rewrites one, reading a channel clears its seam. So everything that
        // is not an append lands after the held messages do.
        if (event.type === "networkRemoved") flushRosters();
        flushTimelines();
        flushRawLines();

        // Each event reduces against what the ones before it left, so a batch
        // reads the same as the same events applied one at a time.
        const patch = reduce(next, event);
        if (Object.keys(patch).length > 0) next = { ...next, ...patch };
      }
      flushRosters();
      flushTimelines();
      flushRawLines();
      return next === s ? {} : next;
    }),

  setActive: (target) =>
    set((s) => {
      const id = s.activeViewId;
      if (!target) {
        if (!id) return {};
        return retarget(s, id, "", "");
      }

      const read = readingTarget(s, target);
      if (!id) {
        const view = newView(target.network, target.target);
        const layout: Layout = { type: "view", id: view.id };
        return {
          views: { ...s.views, [view.id]: view },
          viewOrder: paneOrder(layout),
          activeViewId: view.id,
          layout,
          ...read,
        };
      }
      const moved = retarget(s, id, target.network, target.target);
      return { ...moved, ...read, ...leftBehind(s, moved.views ?? s.views, target) };
    }),

  showTarget: (target) => {
    const showing = paneShowing(get(), target);
    if (showing === undefined) {
      get().setActive(target);
      return;
    }
    // Reading it is reading it wherever it was already open, so the recency
    // list and the conversation being left move either way.
    set((s) => ({
      activeViewId: showing,
      ...readingTarget(s, target),
      ...leftBehind(s, s.views, target),
    }));
  },

  openConsole: (network, raw = false) => {
    get().showTarget({ network, target: SERVER_TARGET });
    const id = get().activeViewId;
    if (id) get().setViewRaw(id, raw);
  },

  setViewAnchor: (view, row) =>
    set((s) => {
      if (!s.views[view] || s.viewAnchor[view] === row) return {};
      return { viewAnchor: { ...s.viewAnchor, [view]: row } };
    }),

  setMessageJump: (view, message) =>
    set((s) => {
      if (!s.views[view]) return {};
      const messageJump = { ...s.messageJump };
      if (message === null) delete messageJump[view];
      else messageJump[view] = message;
      return { messageJump };
    }),

  setLatestJump: (view, wanted) =>
    set((s) => {
      if (!s.views[view]) return {};
      if (wanted === (s.latestJump[view] ?? false)) return {};
      const latestJump = { ...s.latestJump };
      if (wanted) latestJump[view] = true;
      else delete latestJump[view];
      return { latestJump };
    }),

  setViewSelectedUser: (view, nick) =>
    set((s) => {
      const current = s.views[view];
      if (!current || current.selectedUser === nick) return {};
      return { views: { ...s.views, [view]: { ...current, selectedUser: nick } } };
    }),

  setViewRaw: (view, raw) =>
    set((s) => {
      const current = s.views[view];
      if (!current || current.raw === raw) return {};
      return { views: { ...s.views, [view]: { ...current, raw } } };
    }),

  setConsoleInput: (view, input) =>
    set((s) => {
      if (!s.views[view]) return {};
      const current = s.consoleInput[view];
      if (current && current.text === input.text && current.error === input.error) return {};
      return { consoleInput: { ...s.consoleInput, [view]: input } };
    }),

  setRawAnchor: (view, line) =>
    set((s) => {
      if (!s.views[view] || s.rawAnchor[view] === line) return {};
      return { rawAnchor: { ...s.rawAnchor, [view]: line } };
    }),

  setComposerError: (view, reason) =>
    set((s) => {
      if (!s.views[view] || (s.composerError[view] ?? null) === reason) return {};
      return { composerError: { ...s.composerError, [view]: reason } };
    }),

  splitActiveView: (direction) =>
    set((s) => {
      const active = s.activeViewId ? s.views[s.activeViewId] : undefined;
      if (!active || !s.layout) return {};

      const opened = newView(active.network, active.target);
      const layout = splitLeaf(s.layout, active.id, direction, opened.id);
      return {
        layout,
        views: { ...s.views, [opened.id]: opened },
        viewOrder: paneOrder(layout),
        activeViewId: opened.id,
      };
    }),

  closeView: (view) =>
    set((s) => {
      if (!s.layout || !s.views[view] || s.viewOrder.length < 2) return {};
      const layout = removeLeaf(s.layout, view);
      if (!layout) return {};

      const closed = s.views[view];
      const { [view]: _closed, ...views } = s.views;
      const { [view]: _read, ...viewAnchor } = s.viewAnchor;
      // Otherwise a later pane handed the same id would open with the closed
      // pane's roster hidden.
      const { [view]: _hidden, ...rosterHidden } = s.rosterHidden;
      const { [view]: _narrowed, ...memberFilter } = s.memberFilter;
      const { [view]: _typed, ...consoleInput } = s.consoleInput;
      const { [view]: _line, ...rawAnchor } = s.rawAnchor;
      const { [view]: _refusal, ...composerError } = s.composerError;
      const { [view]: _latest, ...latestJump } = s.latestJump;
      const at = s.viewOrder.indexOf(view);
      // Closing the focused pane is leaving its conversation: the seam it was
      // read under would otherwise wait, stale, for the next visit.
      const seam =
        s.activeViewId === view &&
        closed?.network &&
        !Object.values(views).some(
          (v) => v.network === closed.network && v.target === closed.target,
        )
          ? clearedSeam(s, closed.network, closed.target)
          : {};
      return {
        layout,
        views,
        viewAnchor,
        rosterHidden,
        memberFilter,
        consoleInput,
        rawAnchor,
        composerError,
        latestJump,
        viewOrder: paneOrder(layout),
        activeViewId:
          s.activeViewId === view
            ? (s.viewOrder[at + 1] ?? s.viewOrder[at - 1] ?? null)
            : s.activeViewId,
        ...seam,
      };
    }),

  focusView: (view) =>
    set((s) => (s.views[view] && s.activeViewId !== view ? { activeViewId: view } : {})),

  // Already open is moved to, not opened again: one window's worth of settings
  // twice over is two answers to every question on them. Which the dialog gets
  // for free — it is one or nothing.
  openSettings: (section) => set((s) => ({ settings: section ?? s.settings ?? SECTIONS[0]!.id })),

  // `setup` goes with both: it is a screen of the Networks page, so leaving the
  // page leaves it. Coming back to a half-filled form somebody walked away from
  // is not what reopening settings means.
  closeSettings: () => set((s) => (s.settings ? { settings: null, setup: null } : {})),

  setSettingsSection: (section) =>
    set((s) => (s.settings ? { settings: section, setup: null } : {})),

  setSplitRatio: (path, ratio) =>
    set((s) => {
      if (!s.layout) return {};
      const layout = setRatio(s.layout, path, ratio);
      return layout === s.layout ? {} : { layout };
    }),

  restoreLayout: (stored) =>
    set((s) => {
      // A pane opened while the snapshot was in flight is the user's, and it
      // outranks what the last run left.
      if (s.layout) return {};

      const kept = fromStored(stored, (network, target) => {
        if (!s.networks[network]) return false;
        // A console is the network itself, so it is there as long as the
        // network is; every other target has to still be open.
        if (target === SERVER_TARGET) return true;
        const key = targetKey(network, target);
        return key in s.channels || key in s.queries;
      });
      if (!kept) return {};

      const views: Record<ViewId, ChatView> = {};
      const layout = openStored(kept, (pane) => {
        const view = { ...newView(pane.network, pane.target), raw: pane.raw };
        views[view.id] = view;
        return view.id;
      });

      // The first pane takes focus. Which one had it is not written down, for
      // the same reason the scroll position is not: where a pane was looking
      // belongs to the run it was looking in.
      const viewOrder = paneOrder(layout);
      return { layout, views, viewOrder, activeViewId: viewOrder[0] ?? null };
    }),

  prependHistory: (key, older, hasMore) =>
    set((s) => {
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      const known = new Set(timeline.messages.map((m) => m.id));
      const fresh = older.filter((m) => !known.has(m.id));
      // Paging backwards stops at the cap (#331) — the same figure appends
      // hold the other end to. Only the scroll handler's own diligence
      // enforced it before, and the handler had none: holding scroll-up grew
      // the window without bound, and every later live message paid for its
      // size. The newest of the page is what fits, so the window stays
      // contiguous; a page that had to be cut ends the paging.
      const room = Math.max(0, TIMELINE_CAP - timeline.messages.length);
      const kept = fresh.slice(Math.max(0, fresh.length - room));
      // A page is almost always wholly behind the window, which is a concat.
      // It is not guaranteed to be: the read is asked with the oldest message
      // on screen and awaited, and an empty timeline asks with `before` null,
      // which `load_history` answers with the newest page it holds rather than
      // with a page behind anything. Either way the server's own history can
      // land while the archive is being read, and filing today's rows in front
      // of yesterday's is what the reader sees.
      const head = timeline.messages[0];
      const newest = kept[kept.length - 1];
      const ordered =
        !head || !newest || Date.parse(newest.timestamp) <= Date.parse(head.timestamp)
          ? [...kept, ...timeline.messages]
          : mergeByTime(timeline.messages, kept, readBack(kept));
      return {
        timelines: {
          ...s.timelines,
          [key]: {
            ...timeline,
            messages: ordered,
            // `&& timeline.hasMore`, so that paging stopped stays stopped. The
            // caller computed `hasMore` before the page it is filing, and a
            // page of history landing in between can have ended the paging on
            // its own — the server answering with nothing behind the message it
            // was asked about (#522). Nothing ever turned this back on: below
            // the cap the reader is refused at `!current.hasMore` before a read
            // is even attempted.
            hasMore: timeline.hasMore && (kept.length < fresh.length ? false : hasMore),
            loadingOlder: false,
          },
        },
      };
    }),

  replaceHistory: (key, messages) =>
    set((s) => {
      const held = s.timelines[key];
      return {
        timelines: {
          ...s.timelines,
          [key]: {
            ...EMPTY_TIMELINE,
            messages,
            // Where the reader stopped is not a fact about the window, and a
            // jump is not a departure — `leftBehind` declines for the target
            // already being shown, and `readingTarget` says why. Both survive
            // the write, so the rule comes back with the tail (#623).
            //
            // The msgid can name a message this window does not hold, which
            // every reader of it already answers for: `buildRows` never
            // matches it, and `catchUpMessages` and the mention cursor both
            // give back nothing on `-1`.
            unreadFrom: held?.unreadFrom ?? null,
            readMarker: held?.readMarker ?? null,
            detachedAt: detachedAt(held, messages),
          },
        },
      };
    }),

  setStartupFailure: (reason) => set({ startupFailure: reason }),
  clearBuffer: (key) =>
    set((s) => ({
      timelines: {
        ...s.timelines,
        [key]: { ...EMPTY_TIMELINE, hasMore: false },
      },
    })),

  setLoadingOlder: (key, loading) =>
    set((s) => ({
      timelines: {
        ...s.timelines,
        [key]: { ...(s.timelines[key] ?? EMPTY_TIMELINE), loadingOlder: loading },
      },
    })),

  setAskedBehind: (key, msgid) =>
    set((s) => ({
      timelines: {
        ...s.timelines,
        [key]: { ...(s.timelines[key] ?? EMPTY_TIMELINE), askedBehind: msgid },
      },
    })),

  clearUnreadMarker: (key) =>
    set((s) => {
      const timeline = s.timelines[key];
      if (!timeline) return {};
      return { timelines: { ...s.timelines, [key]: { ...timeline, unreadFrom: null } } };
    }),

  setReplyTo: (network, target, msgid) =>
    set((s) => {
      const key = targetKey(network, target);
      if (msgid === null) {
        const { [key]: _cleared, ...replyTo } = s.replyTo;
        return { replyTo };
      }
      return { replyTo: { ...s.replyTo, [key]: msgid } };
    }),

  rememberInput: (network, target, text) =>
    set((s) => {
      const key = targetKey(network, target);
      const history = s.inputHistory[key] ?? [];
      // The same line sent twice running is one entry, so the second Up reaches
      // what came before it rather than saying the same thing again.
      if (history[0] === text) return s;
      return {
        inputHistory: {
          ...s.inputHistory,
          [key]: [text, ...history].slice(0, INPUT_HISTORY_CAP),
        },
      };
    }),

  setDraftPresence: (network, target, present) =>
    set((s) => {
      const key = targetKey(network, target);
      if (present) {
        if (s.drafts[key]) return {};
        return { drafts: { ...s.drafts, [key]: true } };
      }
      if (!s.drafts[key]) return {};
      const { [key]: _cleared, ...drafts } = s.drafts;
      return { drafts };
    }),

  setBookmarked: (network, target, message, active) =>
    set((s) => {
      const key = targetKey(network, target);
      const current = s.bookmarks[key] ?? [];
      const next = active
        ? current.includes(message) ? current : [...current, message]
        : current.filter((id) => id !== message);
      return { bookmarks: { ...s.bookmarks, [key]: next } };
    }),

  toggleRoster: (view, shown) =>
    set((s) => {
      const hidden = s.rosterHidden[view] === true;
      return {
        rosterHidden: {
          ...s.rosterHidden,
          [view]: shown === undefined ? !hidden : !shown,
        },
      };
    }),

  setMemberFilter: (view, text) =>
    set((s) => {
      if (text === null) {
        if (!(view in s.memberFilter)) return {};
        const { [view]: _cleared, ...memberFilter } = s.memberFilter;
        return { memberFilter };
      }
      if (s.memberFilter[view] === text) return {};
      return { memberFilter: { ...s.memberFilter, [view]: text } };
    }),

  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openSearch: (searchMode = "search") => set({ searchOpen: true, searchMode }),
  closeSearch: () => set({ searchOpen: false }),

  openSetup: (network) => set({ setup: { network }, settings: "networks" }),
  openIrcSetup: (link) => set({ setup: { network: null, link }, settings: "networks" }),
  closeSetup: () => set({ setup: null }),

  setUploadRequest: (paths) =>
    set({ uploadRequest: paths === null || paths.length === 0 ? null : paths }),
  showChannels: (network) => set({ channelsOpen: network }),
  browseChannels: (network) =>
    set((s) => {
      const { [network]: _stale, ...channelList } = s.channelList;
      return { channelsOpen: network, channelList };
    }),
  setHighlightWords: (highlightWords) => set({ highlightWords }),
  setHushedNicks: (hushedNicks) => set({ hushedNicks }),
  setPlugins: (plugins) => set({ plugins, pluginsUnavailable: null }),
  setPluginsUnavailable: (reason) => set({ plugins: [], pluginsUnavailable: reason }),
  upsertPlugin: (plugin) =>
    set((s) => {
      const at = s.plugins.findIndex((held) => held.id === plugin.id);
      if (at !== -1) {
        const plugins = s.plugins.slice();
        plugins[at] = plugin;
        return { plugins };
      }
      // `list_plugins` reads a BTreeMap, so the backend's order is by id. A new
      // plugin appended would sit last until the next launch and then move.
      const plugins = [...s.plugins, plugin].sort((a, b) => a.id.localeCompare(b.id));
      return { plugins };
    }),
  dropPlugin: (plugin) =>
    set((s) => ({ plugins: s.plugins.filter((held) => held.id !== plugin) })),

  toggleNetworkCollapsed: (network) =>
    set((s) => ({
      collapsedNetworks: {
        ...s.collapsedNetworks,
        [network]: !s.collapsedNetworks[network],
      },
    })),

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(400, Math.max(180, px)) }),

  setSidebarCompact: (compact) => set({ sidebarCompact: compact }),

  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),

  togglePinnedTarget: (target) =>
    set((s) => ({
      pinnedTargets: s.pinnedTargets.includes(target)
        ? s.pinnedTargets.filter((held) => held !== target)
        : [...s.pinnedTargets, target],
    })),

  // The floor is the 8rem the column already refused to go under: a group
  // heading is drawn whatever the nicks are, and it sits in a row of fixed
  // height, so narrower means a heading wrapping into the member below it.
  // Rounded, unlike the sidebar's, because that one is given a `clientX` and
  // this one a measured box: `getBoundingClientRect` answers in fractions of a
  // pixel, and `aria-valuenow` is read out as it stands.
  setRosterWidth: (px) =>
    set({ rosterWidth: px === null ? null : Math.round(Math.min(400, Math.max(128, px))) }),

  setThemeCatalogue: ({ themes, broken }) => set({ themes, brokenThemes: broken }),
  setThemeId: (id) => set({ themeId: id }),
  setDensity: (id) => set({ density: id }),
  setPresentation: (next) => set({ presentation: next }),
  setTypography: (next) => set({ typography: next }),
  setOverrides: (next) => set({ overrides: next }),
}));

/**
 * The first pane already on `target`, if any. Splitting deliberately opens a
 * second view on one target, so more than one pane can be showing it; pane
 * order decides, rather than whichever the map happened to yield.
 */
function paneShowing(s: AppState, target: ActiveTarget): ViewId | undefined {
  return s.viewOrder.find((id) => {
    const view = s.views[id];
    return (
      view !== undefined &&
      view.network === target.network &&
      sameTarget(view.target, target.target)
    );
  });
}

/**
 * A conversation that is gone takes its panes with it. `fromStored` already
 * drops them on the way back in, so a pane left behind is one the next launch
 * would silently not reopen — and until then it holds a composer addressed to
 * somewhere the client is no longer in.
 *
 * Splitting opens the second pane on the same target, so two panes on one
 * conversation is the ordinary result of a split rather than an edge case.
 * When they are all that is left one is emptied instead of removed — the state
 * `setActive(null)` leaves, and the one `toStored` refuses to write down.
 */
function dropPanesOn(s: AppState, network: string, target: string): Partial<AppState> {
  const showing = s.viewOrder.filter((id) => {
    const view = s.views[id];
    return view !== undefined && view.network === network && sameTarget(view.target, target);
  });
  if (showing.length === 0 || !s.layout) return {};

  // The one pane the window keeps, when the conversation being closed is the
  // only thing open.
  const survivor = showing.length === s.viewOrder.length ? showing[0] : undefined;
  const views = { ...s.views };
  const viewAnchor = { ...s.viewAnchor };
  const rosterHidden = { ...s.rosterHidden };
  const memberFilter = { ...s.memberFilter };
  const consoleInput = { ...s.consoleInput };
  const rawAnchor = { ...s.rawAnchor };
  const composerError = { ...s.composerError };
  let layout = s.layout;

  for (const id of showing) {
    if (id === survivor) continue;
    const left = removeLeaf(layout, id);
    if (!left) continue;
    layout = left;
    delete views[id];
    delete viewAnchor[id];
    delete rosterHidden[id];
    delete memberFilter[id];
    delete consoleInput[id];
    delete rawAnchor[id];
    delete composerError[id];
  }

  const kept = survivor === undefined ? undefined : views[survivor];
  if (survivor !== undefined && kept !== undefined) {
    views[survivor] = { ...kept, network: "", target: "", selectedUser: null, raw: false };
    viewAnchor[survivor] = null;
    // Not `rosterHidden`, which the pane above keeps: whether a pane draws a
    // roster is its own, while what a roster is narrowed to belongs to the
    // channel that was being narrowed.
    delete memberFilter[survivor];
    delete consoleInput[survivor];
    delete rawAnchor[survivor];
    delete composerError[survivor];
  }

  const viewOrder = paneOrder(layout);
  return {
    layout,
    views,
    viewAnchor,
    rosterHidden,
    memberFilter,
    consoleInput,
    rawAnchor,
    composerError,
    viewOrder,
    activeViewId:
      s.activeViewId && viewOrder.includes(s.activeViewId)
        ? s.activeViewId
        : (viewOrder[0] ?? null),
  };
}

/**
 * What reading a target does whichever pane it is read in: it moves to the
 * top of the recency list. Its unread seam is deliberately left standing —
 * the seam is what the reader switched here to see, and it holds still while
 * they read. Leaving is what clears it; see `leftBehind`.
 */
function readingTarget(s: AppState, target: ActiveTarget): Pick<AppState, "recent"> {
  const key = targetKey(target.network, target.target);
  return {
    recent: [key, ...s.recent.filter((k) => k !== key)].slice(0, RECENT_CAP),
  };
}

/**
 * The seam of the conversation being left. Read while it was active, so it
 * clears — but only once no pane shows it. On screen it holds where it is,
 * and the pane that retargets or closes off it is what finally takes it. The
 * rule lives beside the target rather than the view: having read a channel
 * in one pane means having read it.
 */
function leftBehind(
  s: AppState,
  views: AppState["views"],
  next: ActiveTarget,
): Partial<Pick<AppState, "timelines">> {
  const active = s.activeViewId ? s.views[s.activeViewId] : undefined;
  if (!active || !active.network) return {};
  if (active.network === next.network && active.target === next.target) return {};
  const shown = Object.values(views).some(
    (view) => view.network === active.network && view.target === active.target,
  );
  return shown ? {} : clearedSeam(s, active.network, active.target);
}

function clearedSeam(
  s: AppState,
  network: string,
  target: string,
): Partial<Pick<AppState, "timelines">> {
  const key = targetKey(network, target);
  const timeline = s.timelines[key];
  if (!timeline || timeline.unreadFrom === null) return {};
  return { timelines: { ...s.timelines, [key]: { ...timeline, unreadFrom: null } } };
}

function newView(network: string, target: string): ChatView {
  return { id: mintViewId(), network, target, selectedUser: null, raw: false };
}

/** Retargeting resets the view's own position — the scroll, the inspector and
 * any half-typed command belonged to the conversation it was showing, not to
 * the pane. */
function retarget(
  s: Pick<
    AppState,
    "views" | "viewAnchor" | "memberFilter" | "consoleInput" | "rawAnchor" | "composerError"
  >,
  id: ViewId,
  network: string,
  target: string,
): Partial<AppState> {
  const view = s.views[id];
  if (!view) return {};
  if (view.network === network && view.target === target) return {};
  const { [id]: _narrowed, ...memberFilter } = s.memberFilter;
  const { [id]: _typed, ...consoleInput } = s.consoleInput;
  const { [id]: _line, ...rawAnchor } = s.rawAnchor;
  const { [id]: _refusal, ...composerError } = s.composerError;
  return {
    views: {
      ...s.views,
      [id]: { ...view, network, target, selectedUser: null, raw: false },
    },
    viewAnchor: { ...s.viewAnchor, [id]: null },
    memberFilter,
    consoleInput,
    rawAnchor,
    composerError,
  };
}

/** The three events that only change who is in a channel, which `applyEvents`
 * coalesces. Everything else in a batch goes through `reduce` one at a time. */
type RosterEvent = Extract<
  IrcxEvent,
  { type: "membersReplaced" | "memberUpdated" | "memberRemoved" }
>;

/**
 * The working roster this batch is holding for `event`'s channel, or undefined
 * if `event` is not a roster event at all. Opens one from what the batch has
 * built so far the first time a channel is touched.
 */
function rosterFor(
  event: IrcxEvent,
  next: AppState,
  pending: Map<TargetKey, Map<string, Member>>,
): Map<string, Member> | undefined {
  if (
    event.type !== "membersReplaced" &&
    event.type !== "memberUpdated" &&
    event.type !== "memberRemoved"
  ) {
    return undefined;
  }
  const key = targetKey(event.network, event.channel);
  const held = pending.get(key);
  if (held !== undefined) return held;

  const current = next.members[key];
  // Taking somebody out of a channel with no roster changes nothing, the way it
  // does not in `reduce` — which is where this one falls through to. Adding one
  // opens a roster holding them, so only the removal returns here.
  if (current === undefined && event.type === "memberRemoved") return undefined;
  const roster = new Map((current ?? []).map((member) => [member.nick, member]));
  pending.set(key, roster);
  return roster;
}

/** Insertion order is the order the list is drawn in, so `set` on somebody
 * already there replaces them where they are rather than moving them to the
 * end — which is what assigning into the array did. */
function applyRoster(roster: Map<string, Member>, event: RosterEvent): void {
  switch (event.type) {
    case "membersReplaced":
      roster.clear();
      for (const member of event.members) roster.set(member.nick, member);
      return;
    case "memberUpdated":
      roster.set(event.member.nick, event.member);
      return;
    case "memberRemoved":
      roster.delete(event.nick);
  }
}

/** What `applyEvents` builds for one conversation while a batch runs: the
 * messages it will hand the timeline, where the seam landed on the way, and
 * whether the page somebody was waiting for arrived in it. */
type HeldTimeline = {
  messages: ChatMessage[];
  unreadFrom: string | null;
  askedBehind: string | null;
  hasMore: boolean;
};

/** What a landing page does to the conversation that asked for one.
 *
 * The guard comes off when the page it names arrives, whether or not the window
 * kept any of it: a page carrying only rows the pane already holds moves no
 * message for the guard to come off by, and waiting for one to move refused
 * every later scroll for a page that had arrived (#522).
 *
 * Which page that is, the batch says. Two page-backs can be outstanding on one
 * conversation — a reader who gave up on the first asked again — and both are
 * answered, so a batch was read as the answer to whichever ask happened to be
 * armed when it landed. That ended the history behind a message the server was
 * never asked about, and left the pane refusing to page for the rest of the run
 * (#540).
 *
 * Nothing new in the page this ask named is the server saying it has nothing
 * behind that message, whatever the page's size said about fullness: the pane
 * stops paging and says where the history ends, rather than refusing every
 * later scroll in silence. */
function afterHistoryLanded(
  timeline: Pick<TimelineState, "askedBehind" | "hasMore">,
  fresh: number,
  answers: string | null,
): Pick<TimelineState, "askedBehind" | "hasMore"> {
  const answered = timeline.askedBehind !== null && answers === timeline.askedBehind;
  if (!answered) return { askedBehind: timeline.askedBehind, hasMore: timeline.hasMore };
  return { askedBehind: null, hasMore: fresh === 0 ? false : timeline.hasMore };
}

/** Whether a window filed over a conversation reaches the present, and where it
 * stops if it does not (#618).
 *
 * What the pane already held is the evidence: a window that ends earlier than
 * what was on screen is one that stops short of it. That reads both ways, which
 * is why it is a comparison rather than a flag — the tail read back by `Jump to
 * latest` ends *later* than the detached window it replaces, and the same line
 * says so and clears the mark.
 *
 * A pane holding nothing is taken to be detached, because nothing here can say
 * otherwise — a jump into a conversation this run has never opened is answered
 * out of the archive, and the archive's own newest is not what was asked for.
 * It errs toward offering the way back: a reader who did not need it reads the
 * same messages again, and one who did is not stranded, which is the bug.
 */
function detachedAt(
  held: TimelineState | undefined,
  filed: readonly ChatMessage[],
): string | null {
  const newest = filed[filed.length - 1];
  if (!newest) return null;
  const wasNewest = held?.messages[held.messages.length - 1];
  if (!wasNewest) return newest.id;
  return Date.parse(newest.timestamp) < Date.parse(wasNewest.timestamp) ? newest.id : null;
}

/** Older messages stay in SQLite, so the window keeps its newest `TIMELINE_CAP`
 * and nothing else. */
function capped(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > TIMELINE_CAP ? messages.slice(-TIMELINE_CAP) : messages;
}

/**
 * Where the unread rule goes when a batch lands, and null for a conversation
 * the reader is caught up on.
 *
 * A live arrival opens one where the reader is not looking. A page of history
 * cannot open one on its own — it is what was said before anybody looked — but
 * a read marker says where they stopped, and what a page holds past that is
 * what they were away for. Without the marker there is nothing to place a rule
 * against and the page stays unmarked, which is what a server with no
 * `draft/read-marker` gets. #566.
 *
 * The batch rather than the window: a page walks a gap oldest first, so the
 * first message past the marker is in the page that reaches it, and scanning
 * the window would sweep thousands of rows per delivery to learn the same.
 */
function seamAt(
  fresh: ChatMessage[],
  isActive: boolean,
  readMarker: string | null,
): string | null {
  const live = fresh.find((message) => message.source !== "serverHistory");
  if (live) return isActive || live.sender.isSelf ? null : live.id;
  if (readMarker === null) return null;
  const marker = Date.parse(readMarker);
  const missed = fresh.find(
    (message) => !message.sender.isSelf && Date.parse(message.timestamp) > marker,
  );
  return missed?.id ?? null;
}

/**
 * `messagesAppended` against the list this batch is building rather than
 * against the store. Reads the same as `reduce`'s case, which is what
 * `index.test.ts` asserts; the difference is that the list is this batch's own,
 * so it can be extended instead of rebuilt.
 */
function holdMessages(
  event: Extract<IrcxEvent, { type: "messagesAppended" }>,
  next: AppState,
  timelines: Map<TargetKey, HeldTimeline>,
): void {
  const key = targetKey(event.network, event.target);
  const timeline = next.timelines[key] ?? EMPTY_TIMELINE;
  const held = timelines.get(key);
  const messages = held?.messages ?? timeline.messages;

  // A duplicate is an echo or a replay carrying the timestamp of what it
  // duplicates, so only the stretch of the window as new as the batch's oldest
  // message can hold one. For live traffic that stretch is empty, which spares
  // sweeping a 10k window per delivery.
  const oldest = Math.min(...event.messages.map((m) => Date.parse(m.timestamp)));
  const known = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const seen = messages[i]!;
    if (Date.parse(seen.timestamp) < oldest) break;
    known.add(seen.id);
  }
  const fresh = event.messages.filter((m) => !known.has(m.id));
  // The page a pane is waiting on is worth opening the conversation for even
  // when every row of it is already held, because its arriving is what is being
  // waited for (#522).
  const answering = event.answers !== null;
  if (fresh.length === 0 && !answering) return;

  const opened = held ?? {
    messages: timeline.messages.slice(),
    unreadFrom: timeline.unreadFrom,
    askedBehind: timeline.askedBehind,
    hasMore: timeline.hasMore,
  };
  if (!held) timelines.set(key, opened);
  if (answering) Object.assign(opened, afterHistoryLanded(opened, fresh.length, event.answers));
  if (fresh.length === 0) return;

  const last = opened.messages[opened.messages.length - 1];
  const history = readBack(fresh);
  if (last && sortsBefore(fresh[0]!, last, history)) {
    opened.messages = mergeByTime(opened.messages, fresh, history);
  } else {
    for (const message of fresh) opened.messages.push(message);
  }

  const focused = next.activeViewId ? next.views[next.activeViewId] : undefined;
  const isActive =
    focused?.network === event.network && focused.target === event.target;
  opened.unreadFrom ??= seamAt(fresh, isActive, timeline.readMarker);
}

function reduce(s: AppState, event: IrcxEvent): Partial<AppState> {
  switch (event.type) {
    case "networkUpdated": {
      const networks = { ...s.networks, [event.network.id]: event.network };
      return { networks, networkOrder: orderNetworks(networks) };
    }

    case "networkRemoved": {
      const { [event.network]: _dropped, ...networks } = s.networks;
      // A view left pointing at a deleted network would render an empty pane
      // with a live-looking header, so blank it instead of dropping the view —
      // closing the last pane is not a thing the layout can express.
      const stale = Object.values(s.views).filter((v) => v.network === event.network);
      const views = stale.length
        ? {
            ...s.views,
            ...Object.fromEntries(
              stale.map((v) => [
                v.id,
                { ...v, network: "", target: "", selectedUser: null, raw: false },
              ]),
            ),
          }
        : s.views;
      const viewAnchor = stale.length
        ? { ...s.viewAnchor, ...Object.fromEntries(stale.map((v) => [v.id, null])) }
        : s.viewAnchor;
      const consoleInput = { ...s.consoleInput };
      const rawAnchor = { ...s.rawAnchor };
      const composerError = { ...s.composerError };
      for (const view of stale) {
        delete consoleInput[view.id];
        delete rawAnchor[view.id];
        delete composerError[view.id];
      }

      // Everything else keyed by the network or its conversations goes with
      // it. Left behind, a network re-added under the same id resurrected the
      // dead raw log, stale typing expiries and reply targets, and a whole
      // /list answer — and editing networks grew the store monotonically.
      const { [event.network]: _log, ...rawLog } = s.rawLog;
      const { [event.network]: _list, ...channelList } = s.channelList;
      const prefix = networkPrefix(event.network);
      return {
        networks,
        networkOrder: s.networkOrder.filter((n) => n !== event.network),
        channels: dropByNetwork(s.channels, event.network),
        queries: dropByNetwork(s.queries, event.network),
        timelines: dropByNetwork(s.timelines, event.network),
        members: dropByNetwork(s.members, event.network),
        typing: dropByNetwork(s.typing, event.network),
        replyTo: dropByNetwork(s.replyTo, event.network),
        inputHistory: dropByNetwork(s.inputHistory, event.network),
        drafts: dropByNetwork(s.drafts, event.network),
        rawLog,
        channelList,
        recent: s.recent.filter((key) => !key.startsWith(prefix)),
        pinnedTargets: s.pinnedTargets.filter((key) => !key.startsWith(prefix)),
        views,
        viewAnchor,
        consoleInput,
        rawAnchor,
        composerError,
      };
    }

    case "connectionChanged": {
      const patch = patchNetwork(s, event.network, { status: event.status });
      if (event.status.state === "connected") return patch;
      // The session abandons the page-backs it was waiting on when the
      // connection goes, so what was asked for is not coming and the
      // conversation may ask afresh rather than hold a name nothing will
      // answer for the rest of the run (#487).
      return { ...patch, timelines: forgetPageBacks(s.timelines, event.network) };
    }

    case "saslChanged":
      return patchNetwork(s, event.network, { sasl: event.status });

    case "capsChanged":
      return patchNetwork(s, event.network, { capsEnabled: event.enabled });

    case "lagChanged":
      return patchNetwork(s, event.network, { lagMs: event.lagMs });

    case "messagesAppended": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      // A duplicate is an echo or a replay carrying the timestamp of what it
      // duplicates, so only the stretch of the window as new as the batch's
      // oldest message can hold one. For live traffic that stretch is empty,
      // which spares sweeping a 10k window per delivery.
      const oldest = Math.min(...event.messages.map((m) => Date.parse(m.timestamp)));
      const known = new Set<string>();
      for (let i = timeline.messages.length - 1; i >= 0; i--) {
        const held = timeline.messages[i]!;
        if (Date.parse(held.timestamp) < oldest) break;
        known.add(held.id);
      }
      const fresh = event.messages.filter((m) => !known.has(m.id));
      const answering = event.answers !== null;
      const landed = answering ? afterHistoryLanded(timeline, fresh.length, event.answers) : null;
      if (fresh.length === 0) {
        // A page the window keeps nothing of is still a page that arrived, and
        // for a pane waiting on one that is the whole of what it was waiting
        // for (#522).
        if (!landed) return {};
        return { timelines: { ...s.timelines, [key]: { ...timeline, ...landed } } };
      }

      const merged = mergeByTime(timeline.messages, fresh, readBack(fresh));
      const focused = s.activeViewId ? s.views[s.activeViewId] : undefined;
      const isActive =
        focused?.network === event.network && focused.target === event.target;

      return {
        timelines: {
          ...s.timelines,
          [key]: {
            ...timeline,
            ...landed,
            messages: capped(merged),
            unreadFrom:
              timeline.unreadFrom ?? seamAt(fresh, isActive, timeline.readMarker),
          },
        },
      };
    }

    case "messageUpdated": {
      const key = targetKey(event.message.network, event.message.target);
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      const messages = timeline.messages.slice();
      const at = messages.findIndex((m) => m.id === event.message.id);
      // An update for a message the window does not hold is still the whole
      // message, and dropping it loses the only copy there may ever be.
      if (at === -1) messages.splice(insertionPoint(messages, event.message), 0, event.message);
      else messages[at] = event.message;
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    /** #90. The note arrives after the message it is about, because the
     * annotator runs on arrival rather than on draw. A note naming a message
     * outside this window is dropped here and not lost: the archive holds it
     * and hands it back with the message, exactly as a reaction is. */
    case "messageAnnotated": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key];
      if (!timeline) return {};
      const at = timeline.messages.findIndex((m) => m.id === event.message);
      if (at === -1) return {};

      const held = timeline.messages[at]!;
      const messages = timeline.messages.slice();
      // One note per plugin per message: a plugin answering the same message
      // twice replaces what it said rather than saying it twice.
      messages[at] = {
        ...held,
        annotations: [
          ...(held.annotations ?? []).filter((note) => note.plugin !== event.plugin),
          { plugin: event.plugin, text: event.text },
        ],
      };
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    case "messageRaised": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key];
      if (!timeline) return {};
      const at = timeline.messages.findIndex((m) => m.id === event.message);
      if (at === -1) return {};

      const held = timeline.messages[at]!;
      const raisedBy = held.raisedBy ?? [];
      // A rule raising the same message twice raises it once, as the archive
      // records it once. Applied here as well as read back from the archive,
      // so a message raised while the window is open and the same message
      // after a restart look the same.
      if (raisedBy.includes(event.plugin)) return {};

      const messages = timeline.messages.slice();
      messages[at] = { ...held, raisedBy: [...raisedBy, event.plugin] };
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    case "reactionChanged": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key];
      // A reaction can name a message that scrolled out of this window, or one
      // said before the client connected. The archive keeps it either way and
      // hands it back with the message, so there is nothing to hold here.
      if (!timeline) return {};
      const at = timeline.messages.findIndex((m) => serverMsgid(m) === event.message);
      if (at === -1) return {};

      const held = timeline.messages[at]!;
      const messages = timeline.messages.slice();
      messages[at] = { ...held, reactions: applyReaction(held.reactions ?? [], event) };
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    case "channelUpdated": {
      const key = targetKey(event.channel.network, event.channel.name);
      return { channels: { ...s.channels, [key]: event.channel } };
    }

    /** Whole every time, including the progress ones, so the last to arrive is
     * the answer and nothing has to be merged into what is held. */
    case "transferUpdated":
      return {
        transfers: { ...s.transfers, [event.transfer.id]: event.transfer },
      };

    case "readMarkerUpdated": {
      const key = targetKey(event.network, event.target);
      // Kept even for a conversation with no timeline yet, which is the usual
      // way round on a reconnect: the marker for a channel arrives with the
      // join and the page it belongs to is still being asked for.
      const timeline = { ...(s.timelines[key] ?? EMPTY_TIMELINE), readMarker: event.timestamp };
      const write = { timelines: { ...s.timelines, [key]: timeline } };
      if (timeline.unreadFrom === null) return write;
      const unread = timeline.messages.findIndex((message) => message.id === timeline.unreadFrom);
      if (unread === -1) return write;
      const marker = Date.parse(event.timestamp);
      if (Date.parse(timeline.messages[unread]!.timestamp) > marker) return write;
      const next = timeline.messages
        .slice(unread + 1)
        .find((message) => !message.sender.isSelf && Date.parse(message.timestamp) > marker);
      return {
        timelines: {
          ...s.timelines,
          [key]: { ...timeline, unreadFrom: next?.id ?? null },
        },
      };
    }

    case "channelRemoved": {
      const key = targetKey(event.network, event.name);
      const { [key]: _dropped, ...channels } = s.channels;
      const { [key]: _draft, ...drafts } = s.drafts;
      return { channels, drafts, ...dropPanesOn(s, event.network, event.name) };
    }

    case "queryRemoved": {
      const key = targetKey(event.network, event.nick);
      const { [key]: _dropped, ...queries } = s.queries;
      const { [key]: _draft, ...drafts } = s.drafts;
      return { queries, drafts, ...dropPanesOn(s, event.network, event.nick) };
    }

    /**
     * The person renamed, so the conversation goes with them. #234 fixed the
     * roster half of this; a query is not a name in a list but everything the
     * store keys by that name, and leaving any of it behind splits one
     * conversation into two rows with a dead composer on the older one.
     *
     * What is already archived keeps the name it was said under: a nick is
     * lent, not owned, and re-targeting stored messages would let whoever
     * takes the old one next inherit this conversation.
     */
    case "queryRenamed": {
      const from = targetKey(event.network, event.from);
      const to = targetKey(event.network, event.to);
      if (from === to) return {};
      // The moved row is renamed here rather than left to the `QueryUpdated`
      // that follows: a move that leaves the old name showing is a state the
      // reducer should never produce, whatever arrives next.
      const moved = s.queries[from];
      const queries = moveKey(s.queries, from, to);
      if (moved && queries[to] === moved) queries[to] = { ...moved, nick: event.to };
      return {
        queries,
        timelines: moveKey(s.timelines, from, to),
        typing: moveKey(s.typing, from, to),
        replyTo: moveKey(s.replyTo, from, to),
        drafts: moveKey(s.drafts, from, to),
        recent: s.recent.map((held) => (held === from ? to : held)),
        pinnedTargets: s.pinnedTargets.map((held) => (held === from ? to : held)),
        views: Object.fromEntries(
          Object.entries(s.views).map(([id, view]) => [
            id,
            view.network === event.network && view.target === event.from
              ? { ...view, target: event.to }
              : view,
          ]),
        ),
      };
    }

    case "queryUpdated": {
      const key = targetKey(event.query.network, event.query.nick);
      return { queries: { ...s.queries, [key]: event.query } };
    }

    case "membersReplaced": {
      const key = targetKey(event.network, event.channel);
      return { members: { ...s.members, [key]: event.members } };
    }

    case "memberUpdated": {
      const key = targetKey(event.network, event.channel);
      const current = s.members[key] ?? [];
      const at = current.findIndex((m) => m.nick === event.member.nick);
      const next = current.slice();
      if (at === -1) next.push(event.member);
      else next[at] = event.member;
      return { members: { ...s.members, [key]: next } };
    }

    case "memberRemoved": {
      const key = targetKey(event.network, event.channel);
      const current = s.members[key];
      if (!current) return {};
      return {
        members: { ...s.members, [key]: current.filter((m) => m.nick !== event.nick) },
      };
    }

    case "typingChanged": {
      const key = targetKey(event.network, event.target);
      const current = s.typing[key] ?? {};
      if (!event.active) {
        const { [event.nick]: _stopped, ...rest } = current;
        return { typing: { ...s.typing, [key]: rest } };
      }
      // Servers send a start without a matching stop, so the entry carries its
      // own expiry and the view filters on it.
      return {
        typing: { ...s.typing, [key]: { ...current, [event.nick]: Date.now() + 6_000 } },
      };
    }

    case "ignoredChanged":
      return { ignored: { ...s.ignored, [event.network]: event.nicks } };

    case "channelsListed":
      // The list opens itself: a user types `/list` and waits, and a result that
      // arrived silently would look like nothing happened.
      return {
        channelsOpen: event.network,
        channelList: {
          ...s.channelList,
          [event.network]: { channels: event.channels, truncated: event.truncated },
        },
      };

    case "rawLine": {
      const line = `${event.outgoing ? ">>" : "<<"} ${event.line}`;
      const current = s.rawLog[event.network] ?? [];
      const next = [...current, line];
      return {
        rawLog: {
          ...s.rawLog,
          [event.network]: next.length > RAW_LOG_CAP ? next.slice(-RAW_LOG_CAP) : next,
        },
      };
    }

    case "notice":
      // Rendered by the timeline as a Client message once core routes it to a
      // target; nothing to hold in the store.
      return {};
  }
}

/** What a `+reply` can name a message by. A message this client sent keeps the
 * local id the UI drew it with, so the server's name for it is the `msgid` tag
 * its echo carried — and `null` until one arrives, because a local id names
 * nothing anyone else can resolve. */
export function serverMsgid(message: ChatMessage): string | null {
  if (!message.idIsLocal) return message.id;
  return message.tags.find(([name]) => name === "msgid")?.[1] ?? null;
}

/** Walk every open timeline for a message the UI already drew. */
export function findMessageById(id: string): ChatMessage | undefined {
  for (const timeline of Object.values(useAppStore.getState().timelines)) {
    const found = timeline.messages.find((message) => message.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Adding a reaction someone already holds changes nothing, and taking back one
 * they never sent changes nothing either — a server can deliver either line
 * twice, and the sender's own copy is followed by its echo. */
function applyReaction(
  held: readonly Reaction[],
  event: Extract<IrcxEvent, { type: "reactionChanged" }>,
): Reaction[] {
  const at = held.findIndex((r) => r.emoji === event.emoji);
  if (at === -1) {
    if (!event.active) return [...held];
    return [...held, { emoji: event.emoji, nicks: [event.nick] }];
  }

  const nicks = held[at]!.nicks;
  const next = event.active
    ? nicks.includes(event.nick)
      ? nicks
      : [...nicks, event.nick]
    : nicks.filter((nick) => nick !== event.nick);

  const reactions = held.slice();
  if (next.length === 0) reactions.splice(at, 1);
  else reactions[at] = { emoji: event.emoji, nicks: next };
  return reactions;
}

/**
 * Arriving messages are almost always newer than everything held, and a
 * server backfill is the case where they are not: a channel that spoke while
 * the request was in flight puts a live message ahead of the history that
 * answers it. Both sides are in order on their own, so the out-of-order case
 * is one pass rather than a sort.
 */
function mergeByTime(
  held: readonly ChatMessage[],
  fresh: readonly ChatMessage[],
  freshIsBehind = false,
): ChatMessage[] {
  const last = held[held.length - 1];
  if (!last || !sortsBefore(fresh[0]!, last, freshIsBehind)) {
    return [...held, ...fresh];
  }
  const merged: ChatMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < held.length && j < fresh.length) {
    const takeFresh = sortsBefore(fresh[j]!, held[i]!, freshIsBehind);
    merged.push(takeFresh ? fresh[j++]! : held[i++]!);
  }
  return merged.concat(held.slice(i), fresh.slice(j));
}

/** Whether `a` belongs in front of `b`, with `orTie` deciding a stamp they
 * share — see `readBack` for what decides that. */
function sortsBefore(a: ChatMessage, b: ChatMessage, orTie: boolean): boolean {
  const at = Date.parse(a.timestamp);
  const bt = Date.parse(b.timestamp);
  return orTie ? at <= bt : at < bt;
}

/**
 * Whether a batch is history being read back rather than the conversation
 * happening, which is what tells the merge above which side a tied stamp goes
 * to.
 *
 * **A stamp is a millisecond and a burst is not.** `ergo` gave nine consecutive
 * messages the same timestamp, and the page that landed in front of them
 * shared it — so the clock cannot order the two runs, and something else has to.
 * A merge that breaks the tie towards the window puts the page after messages it
 * precedes, and then the rest of the page after the first stamp that differs:
 * the pane drew `line 0600` and then `line 0611`, with ten of its messages
 * hundreds of pixels further down the block (#602).
 *
 * What the batch *is* rather than where its first message lands: an archive
 * read, a page-back's answer and a gap fill are all history and all belong in
 * front of a message the reader has already been shown at the same millisecond,
 * while a line somebody just said belongs after it. A window whose every
 * message shares one stamp — a fixture, or a channel that took a paste — makes
 * the positional test say history of every live message that arrives.
 *
 * All of them rather than the first: the pump folds two batches together where
 * they answer the same page-back, and a gap fill can be folded with the live
 * line that followed it. A batch that is not wholly history is left ordered the
 * way it was, which is what it was before this and is no worse for the half of
 * it that is live.
 */
function readBack(fresh: readonly ChatMessage[]): boolean {
  return fresh.length > 0 && fresh.every((message) => message.source !== "live");
}

/** A timeline is held in the order the conversation happened, so a message that
 * arrives late lands at its own time rather than at the bottom. */
function insertionPoint(messages: readonly ChatMessage[], message: ChatMessage): number {
  const at = Date.parse(message.timestamp);
  if (Number.isNaN(at)) return messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Date.parse(messages[i]!.timestamp) <= at) return i + 1;
  }
  return 0;
}

/**
 * Moves one conversation's entry to a new key, keeping what is already at the
 * destination. A rename onto a name the store already holds is the two of them
 * meeting; the older entry is the one that has been read, so it wins.
 */
function moveKey<T>(held: Record<string, T>, from: string, to: string): Record<string, T> {
  const moved = held[from];
  if (moved === undefined) return held;
  const next: Record<string, T> = { ...held };
  delete next[from];
  if (!(to in next)) next[to] = moved;
  return next;
}

function patchNetwork(
  s: AppState,
  id: string,
  patch: Partial<AppState["networks"][string]>,
): Partial<AppState> {
  const current = s.networks[id];
  if (!current) return {};
  return { networks: { ...s.networks, [id]: { ...current, ...patch } } };
}

/**
 * The names, rather than the order the servers answered in. Each network is a
 * lane of its own in the event pump and one `NetworkUpdated` supersedes another
 * inside a lane, so arrival order is the order they connected in: two dialling
 * at once came out reversed between one launch and the next (#480). Recomputed
 * on every update because a rename arrives as one, and the id breaks a tie
 * because nothing makes a name unique.
 */
function orderNetworks(networks: AppState["networks"]): string[] {
  return Object.keys(networks).sort(
    (a, b) =>
      networks[a]!.name.localeCompare(networks[b]!.name, undefined, { sensitivity: "base" }) ||
      a.localeCompare(b),
  );
}

/** Every conversation on a network forgets what it asked the server for. The
 * same object back where none had asked, so a connection reporting itself does
 * not rebuild a timeline that has not changed. */
function forgetPageBacks(
  timelines: Record<TargetKey, TimelineState>,
  network: string,
): Record<TargetKey, TimelineState> {
  const prefix = networkPrefix(network);
  const next = { ...timelines };
  let forgot = false;
  for (const key of Object.keys(next) as TargetKey[]) {
    const timeline = next[key]!;
    if (!key.startsWith(prefix) || timeline.askedBehind === null) continue;
    next[key] = { ...timeline, askedBehind: null };
    forgot = true;
  }
  return forgot ? next : timelines;
}

function dropByNetwork<T>(map: Record<string, T>, network: string): Record<string, T> {
  const prefix = networkPrefix(network);
  return Object.fromEntries(
    Object.entries(map).filter(([k]) => !k.startsWith(prefix)),
  ) as Record<string, T>;
}

export { EMPTY_TIMELINE, TIMELINE_CAP };
