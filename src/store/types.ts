import type { BrokenTheme, DensityId, Overrides, Theme } from "@/lib/theme";
import type {
  Channel,
  ChannelListing,
  ChatMessage,
  InstalledPlugin,
  Member,
  Network,
  Query,
} from "@/types";
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
  /** Scroller offset per pane, restored when the view regains focus. Two views
   * on one channel scroll independently, which is the whole point of the
   * split. Not on `ChatView`: this is written every scroll frame, and a write
   * there re-renders everything subscribed to the view. Read via `getState`. */
  viewScroll: Record<ViewId, number>;
  /** Depth-first pane order, derived from `layout`. Focus movement and anything
   * that only needs to enumerate panes reads this rather than walking the tree. */
  viewOrder: ViewId[];
  activeViewId: ViewId | null;
  /** Null until the first view opens. */
  layout: Layout | null;

  // Chrome.
  /** Panes whose member list the user has hidden. A roster belongs to the
   * conversation it lists, so every pane draws its own and this records the
   * exceptions rather than the rule. */
  rosterHidden: Record<ViewId, boolean>;
  paletteOpen: boolean;
  searchOpen: boolean;
  /** The network setup sheet: null while it is closed, otherwise the id of the
   * network it is editing, or null inside for one that does not exist yet. */
  setup: { network: string | null } | null;
  pluginsOpen: boolean;
  /** The upload provider sheet, which is one for the whole client rather than
   * one per network: it is storage, not a connection. */
  uploadOpen: boolean;
  archiveOpen: boolean;
  /** The network whose channel list is on screen, or null. Held rather than a
   * boolean because a list belongs to the network that answered it. */
  channelsOpen: string | null;
  /** Every installed plugin, with what it asked for and what it was allowed.
   * Read once at startup, and kept current by the sheet that changes it — the
   * status bar reads the same list with no sheet open. */
  plugins: InstalledPlugin[];
  /** Why the plugin library could not be read, or null when it was. An empty
   * list means no plugins; this means the question could not be answered. */
  pluginsUnavailable: string | null;
  collapsedNetworks: Record<string, boolean>;
  sidebarWidth: number;
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
  /** What the person changed about each theme, keyed by theme id. Held for
   * every theme rather than only the one in force, so switching away and back
   * returns to the palette they left. */
  overrides: Overrides;
  /** The appearance sheet. Listed beside what it changes rather than with the
   * other sheets, because the theme, the density and the overrides are all
   * edited in that one place. */
  appearanceOpen: boolean;
}
