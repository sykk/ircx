import type {
  BrokenTheme,
  DensityId,
  Overrides,
  Presentation,
  Theme,
  Typography,
} from "@/lib/theme";
import type {
  Channel,
  ChannelListing,
  ChatMessage,
  InstalledPlugin,
  Member,
  Network,
  Query,
} from "@/types";
import type { SectionId } from "@/components/settings/sections";
import type { TargetKey } from "./keys";

export interface ActiveTarget {
  network: string;
  target: string;
}

export type ViewId = string;

/**
 * One chat pane. Splitting the window creates another of these, so anything
 * that differs between two panes showing the same channel lives here rather
 * than beside the channel's data — see docs/multiwindow.md.
 */
export interface ChatView {
  id: ViewId;
  network: string;
  /** Channel or query, or `SERVER_TARGET` for the network's console. */
  target: string;
  /** Nick whose inspector is open in this view's context panel. */
  selectedUser: string | null;
  /** On a console target, whether the pane shows the protocol log instead of
   * what the server said. Per pane so two consoles on one network can show
   * different things, and so the sidebar can open straight onto the log. */
  raw: boolean;
}

export interface ConsoleInput {
  text: string;
  /** Why core refused the last command sent from this box, drawn above it. */
  error: string | null;
}

/** `row` puts the two panes side by side, `column` stacks them. */
export type SplitDirection = "row" | "column";

/**
 * How the panes divide the window. A tree rather than a list of panes with one
 * direction: splitting one pane must not rearrange the others, and only nesting
 * expresses a side-by-side pair with one half stacked.
 */
export type Layout =
  | { type: "view"; id: ViewId }
  | {
      type: "split";
      direction: SplitDirection;
      children: [Layout, Layout];
      /** Share of the split the first child takes, 0 to 1. Absent is an even
       * half, so a layout written before anything could be dragged reads the
       * way it always did. */
      ratio?: number;
    };

/**
 * `Layout` as it survives a restart. Its leaves name a conversation rather than
 * a `ViewId`, because ids are minted per run and the pane they named is gone by
 * the time this is read back. What a pane holds is therefore how it is found
 * again, which also means a conversation that no longer exists takes its pane
 * with it — see `fromStored`.
 */
export type StoredLayout =
  | { type: "view"; network: string; target: string; raw: boolean }
  | {
      type: "split";
      direction: SplitDirection;
      children: [StoredLayout, StoredLayout];
      ratio?: number;
    };

export interface TimelineState {
  messages: ChatMessage[];
  /** msgid of the first message below the unread rule; null when caught up. */
  unreadFrom: string | null;
  /** False once the backend reports no older messages remain. */
  hasMore: boolean;
  loadingOlder: boolean;
}

/**
 * Split into three, and the split is load-bearing:
 *
 * World — what the network says is true. Shared by every view that looks at it.
 * View  — where one pane is looking. Keyed by view id, never global.
 * Chrome — application furniture. Global because there is one of each.
 */
export interface AppState {
  // World.
  networks: Record<string, Network>;
  /** Display order in the sidebar; networks arrive unordered. */
  networkOrder: string[];
  channels: Record<TargetKey, Channel>;
  queries: Record<TargetKey, Query>;
  members: Record<TargetKey, Member[]>;
  timelines: Record<TargetKey, TimelineState>;
  /** nick -> epoch ms when the indicator expires. */
  typing: Record<TargetKey, Record<string, number>>;
  /** The server msgid the next message in a conversation answers. Held here
   * rather than in the composer because it is chosen in the timeline, which is
   * a different tree, and shared by every pane on the same conversation. */
  replyTo: Record<TargetKey, string>;
  /** Lines already sent in a conversation, newest first, for the composer to
   * recall. Here for the same reason as `replyTo`: the composer is remounted by
   * every switch between conversations, and what was typed before the switch has
   * to still be there after it. Per conversation rather than one list for the
   * client, so recalling in a channel cannot surface what was said in a query. */
  inputHistory: Record<TargetKey, string[]>;
  /** Raw protocol log per network, capped; the console pane's raw view. */
  rawLog: Record<string, string[]>;
  /** The last `LIST` a network answered, whole. Not `channels`: these are
   * places the user is not in, and knowing about one is not being in it. */
  channelList: Record<string, { channels: ChannelListing[]; truncated: boolean }>;

  // View.
  views: Record<ViewId, ChatView>;
  /** Where each pane is reading, as the id of the timeline row at the top of
   * its screen, or `null` for one following the live edge. Two views on one
   * channel read independently, which is the whole point of the split.
   *
   * A row rather than an offset because a pane is rebuilt whenever the layout
   * changes shape (#308) and comes back a different width, where the same
   * number of pixels is a different message — #307. Not on `ChatView`: this is
   * written every scroll frame, and a write there re-renders everything
   * subscribed to the view. Read via `getState`. */
  viewAnchor: Record<ViewId, string | null>;
  /** What is typed into each console pane's command box, and the refusal under
   * it. Here for the same reason as `viewAnchor`: a console saves no draft, so
   * a pane rebuilt by a change to the layout's shape (#308) came back having
   * lost both — a half-typed command and the reason the last one was refused,
   * which is the loss #299 was filed for. */
  consoleInput: Record<ViewId, ConsoleInput>;
  /** Where each pane showing the protocol log is reading, as the index of the
   * line at the top of its screen, or `null` for one following the tail. The
   * counterpart of `viewAnchor` for the other thing a console pane can draw,
   * and separate from it so toggling between the two keeps both.
   *
   * An index rather than a line, because a line has no id and its text is not
   * unique — a `PING` recurs. That holds while the buffer only grows; once it
   * is at `RAW_LOG_CAP` every arrival shifts the indices below it down one, so
   * a pane rebuilt during a flood comes back further down the log than it left.
   * Recovering that would need a sequence number the buffer does not keep, and
   * a flood long enough to matter has already rolled the line out of it. */
  rawAnchor: Record<ViewId, number | null>;
  /** Why the last line each pane tried to send was refused, drawn above its
   * composer. Here rather than in the composer for the reason `consoleInput`
   * is: a rebuilt pane loses component state, and the line itself comes back
   * through the backend draft, so losing only the reason left the reader their
   * message returned to the box with nothing saying why. */
  composerError: Record<ViewId, string | null>;
  /** Depth-first pane order, derived from `layout`. Focus movement and anything
   * that only needs to enumerate panes reads this rather than walking the tree. */
  viewOrder: ViewId[];
  activeViewId: ViewId | null;
  /** Null until the first view opens. */
  layout: Layout | null;
  /**
   * The section settings is open on, or null while it is closed.
   *
   * The whole of the state, because settings is drawn over the layout rather
   * than inside it: no leaf, no id, no place in `viewOrder`, and nothing that
   * walks the panes has to be told to pass over it. Not written down either —
   * a run comes back to the conversations it left, not to a dialog.
   */
  settings: SectionId | null;

  // Chrome.
  /** Panes whose member list the user has hidden. A roster belongs to the
   * conversation it lists, so every pane draws its own and this records the
   * exceptions rather than the rule. */
  rosterHidden: Record<ViewId, boolean>;
  /**
   * What each pane's roster is narrowed to. Absent is no filter at all and the
   * band above the list stays empty, which is the roster the mockup draws; `""`
   * is an empty filter open and waiting, which is what the palette entry opens
   * and what a typed character lands in.
   */
  memberFilter: Record<ViewId, string>;
  paletteOpen: boolean;
  searchOpen: boolean;
  /**
   * Which screen the Networks page is on: null for the list, otherwise the id
   * of the network whose form is open — or null inside, for one that does not
   * exist yet.
   *
   * In the store rather than in the page because the entry points are not the
   * page. The sidebar's `+`, a network row's menu, the channel header's `⋮` and
   * the palette each mean "configure this one", and `openSetup` opens settings
   * on Networks and says which one in the same write.
   */
  setup: { network: string | null } | null;
  /** Paths the composer's attach button picked, waiting for the confirmation a
   * drop gets. Here because the dialog that asks the question is mounted with
   * the app rather than inside the pane whose button was pressed; `DropToUpload`
   * clears this as it takes them. */
  uploadRequest: string[] | null;
  /** The network whose channel list is on screen, or null. Held rather than a
   * boolean because a list belongs to the network that answered it. */
  channelsOpen: string | null;
  /** The words that raise a conversation beside the reader's nickname, as the
   * backend holds them. The badge is counted there and the tint is decided
   * here, and this is the copy the second half of that reads. */
  highlightWords: string[];
  /** Every installed plugin, with what it asked for and what it was allowed.
   * Read once at startup, and kept current by the sheet that changes it — the
   * status bar reads the same list with no sheet open. */
  plugins: InstalledPlugin[];
  /** Why the plugin library could not be read, or null when it was. An empty
   * list means no plugins; this means the question could not be answered. */
  pluginsUnavailable: string | null;
  collapsedNetworks: Record<string, boolean>;
  sidebarWidth: number;
  /** What somebody dragged the member list to, or null while it is still
   * sizing itself to the longest name in it. One width for every roster: a
   * pane's id is minted afresh each run, so a width held per pane would not
   * survive the restart the layout itself does. */
  rosterWidth: number | null;
  /** Most recent first. Ranks palette results and drives Alt+Left/Right.
   * Recency is a property of the person, not of a pane. */
  recent: TargetKey[];
  /** Every theme that loaded, the two built-ins first. */
  themes: Theme[];
  /** Directories that did not load, and why. Listed rather than dropped so the
   * picker can say what is wrong instead of the theme not appearing. */
  brokenThemes: BrokenTheme[];
  /** The theme in force. Falls back to the built-in dark theme when it names
   * one that is not installed. */
  themeId: string;
  /** The timeline's vertical rhythm. Separate from the theme so changing how
   * tightly the conversation is set does not change its palette. */
  density: DensityId;
  /** The spine, the clock and the nickname: what the timeline draws, and in
   * what order, as against
   * what colour it draws it in. Apart from the theme for the density's reason,
   * and not tokens, so the components read it from here. */
  presentation: Presentation;
  /** The two faces and the window scale. The faces are painted as tokens after
   * the theme, so a theme cannot take back a font the reader chose. */
  typography: Typography;
  /** What the person changed about each theme, keyed by theme id. Held for
   * every theme rather than only the one in force, so switching away and back
   * returns to the palette they left. */
  overrides: Overrides;
}
