import type { Channel, ChatMessage, Member, Network, Query } from "@/types";
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
  /** Scroller offset, restored when the view regains focus. Two views on one
   * channel scroll independently, which is the whole point of the split. */
  scrollPosition: number;
  /** Nick whose inspector is open in this view's context panel. */
  selectedUser: string | null;
}

/** `row` puts the two panes side by side, `column` stacks them. */
export type SplitDirection = "row" | "column";

/**
 * Where the context panel points, per docs/multiwindow.md.
 *
 * `follow` — the shared sidebar tracks whichever pane has focus. The default.
 * `pinned` — it holds one pane while focus moves, for comparing two channels.
 * `embedded` — it moves inside that pane instead of the shared sidebar.
 */
export type ContextMode = "follow" | "pinned" | "embedded";

/**
 * How the panes divide the window. A tree rather than a list of panes with one
 * direction: splitting one pane must not rearrange the others, and only nesting
 * expresses a side-by-side pair with one half stacked.
 */
export type Layout =
  | { type: "view"; id: ViewId }
  | { type: "split"; direction: SplitDirection; children: [Layout, Layout] };

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
  /** Raw protocol log per network, capped; the console pane's raw view. */
  rawLog: Record<string, string[]>;

  // View.
  views: Record<ViewId, ChatView>;
  /** Depth-first pane order, derived from `layout`. Focus movement and anything
   * that only needs to enumerate panes reads this rather than walking the tree. */
  viewOrder: ViewId[];
  activeViewId: ViewId | null;
  /** Null until the first view opens. */
  layout: Layout | null;

  // Chrome.
  /** One shared context panel that follows focus, so its open state is global
   * while its contents come from the active view. */
  drawerOpen: boolean;
  contextMode: ContextMode;
  /** The pane the panel is attached to, null while it follows focus. This is
   * panel state, not view state: there is one panel, and which pane it points
   * at is a fact about the panel rather than about any pane. */
  contextPane: ViewId | null;
  paletteOpen: boolean;
  searchOpen: boolean;
  /** The network setup sheet: null while it is closed, otherwise the id of the
   * network it is editing, or null inside for one that does not exist yet. */
  setup: { network: string | null } | null;
  collapsedNetworks: Record<string, boolean>;
  sidebarWidth: number;
  /** Most recent first. Ranks palette results and drives Alt+Left/Right.
   * Recency is a property of the person, not of a pane. */
  recent: TargetKey[];
}
