import type { Channel, ChatMessage, Member, Network, Query } from "@/types";
import type { TargetKey } from "./keys";

export interface ActiveTarget {
  network: string;
  target: string;
}

export interface TimelineState {
  messages: ChatMessage[];
  /** msgid of the first message below the unread rule; null when caught up. */
  unreadFrom: string | null;
  /** False once the backend reports no older messages remain. */
  hasMore: boolean;
  loadingOlder: boolean;
}

export interface AppState {
  networks: Record<string, Network>;
  /** Display order in the sidebar; networks arrive unordered. */
  networkOrder: string[];

  channels: Record<TargetKey, Channel>;
  queries: Record<TargetKey, Query>;
  members: Record<TargetKey, Member[]>;
  timelines: Record<TargetKey, TimelineState>;

  /** nick -> epoch ms when the indicator expires. */
  typing: Record<TargetKey, Record<string, number>>;

  active: ActiveTarget | null;
  /** Most recent first. Ranks palette results and drives Alt+Left/Right. */
  recent: TargetKey[];

  drawerOpen: boolean;
  paletteOpen: boolean;
  searchOpen: boolean;
  collapsedNetworks: Record<string, boolean>;
  sidebarWidth: number;

  /** Raw protocol log per network, capped; the `raw log` sidebar entry. */
  rawLog: Record<string, string[]>;
}
