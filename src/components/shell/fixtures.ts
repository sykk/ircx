import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { ActiveTarget, AppState } from "@/store/types";
import type { Channel, Network, Query } from "@/types";

const PRISTINE = useAppStore.getState();

export function resetStore() {
  useAppStore.setState(PRISTINE, true);
}

type ViewSlice = Pick<
  AppState,
  "views" | "viewOrder" | "activeViewId" | "layout" | "viewAnchor"
>;

/** The id `oneView` gives its pane, for a test that renders a pane component. */
export const TEST_VIEW = "test-view";

/** One focused pane on `target`, or none. Spread into a `setState` literal —
 * the view fields only make sense set together, and `setState` merges, so the
 * reading position has to be cleared here or the pane this defines inherits
 * wherever the last test left a pane of the same id. */
export function oneView(target: ActiveTarget | null): ViewSlice {
  if (!target) {
    return { views: {}, viewOrder: [], activeViewId: null, layout: null, viewAnchor: {} };
  }
  const id = TEST_VIEW;
  return {
    views: { [id]: { id, ...target, selectedUser: null, raw: false } },
    viewOrder: [id],
    activeViewId: id,
    layout: { type: "view", id },
    viewAnchor: {},
  };
}

/** Where the focused pane is looking, for tests that assert a navigation. */
export function activeTarget(): ActiveTarget | null {
  const { views, activeViewId } = useAppStore.getState();
  const view = activeViewId ? views[activeViewId] : undefined;
  if (!view || !view.network) return null;
  return { network: view.network, target: view.target };
}

export function makeNetwork(id: string, patch: Partial<Network> = {}): Network {
  return {
    id,
    name: id,
    host: `irc.${id}.net`,
    port: 6697,
    tls: true,
    status: { state: "connected" },
    currentNick: "sable",
    sasl: { state: "notConfigured" },
    capsEnabled: [],
    lagMs: null,
    ...patch,
  };
}

export function makeChannel(
  network: string,
  name: string,
  patch: Partial<Channel> = {},
): Channel {
  return {
    network,
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 0,
    unread: 0,
    highlights: 0,
    ...patch,
  };
}

export function makeQuery(network: string, nick: string, patch: Partial<Query> = {}): Query {
  return { network, nick, account: null, unread: 0, online: true, ...patch };
}

export function seedStore(
  networks: Network[],
  channels: Channel[] = [],
  queries: Query[] = [],
) {
  useAppStore.setState({
    networks: Object.fromEntries(networks.map((n) => [n.id, n])),
    networkOrder: networks.map((n) => n.id),
    channels: Object.fromEntries(channels.map((c) => [targetKey(c.network, c.name), c])),
    queries: Object.fromEntries(queries.map((q) => [targetKey(q.network, q.nick), q])),
  });
}

/** The workspace from docs/mockup.png, for tests and for eyeballing the shell. */
export function seedMockupWorkspace() {
  seedStore(
    [
      makeNetwork("libera", {
        name: "Libera.Chat",
        host: "irc.libera.chat",
        sasl: { state: "authenticated", detail: { account: "sable" } },
        capsEnabled: [
          "sasl",
          "server-time",
          "message-tags",
          "batch",
          "labeled-response",
          "echo-message",
          "multi-prefix",
          "away-notify",
          "chghost",
          "account-notify",
          "extended-join",
          "setname",
        ],
        lagMs: 42,
      }),
      makeNetwork("oftc", { name: "OFTC", host: "irc.oftc.net", lagMs: 88 }),
      makeNetwork("rizon", {
        name: "Rizon",
        host: "irc.rizon.net",
        status: { state: "reconnecting", detail: { inSeconds: 12 } },
      }),
    ],
    [
      makeChannel("libera", "#ctf-ops", { unread: 36, highlights: 2, memberCount: 13 }),
      makeChannel("libera", "#ctf-web", { unread: 6 }),
      makeChannel("libera", "#hackint", { unread: 97 }),
      makeChannel("libera", "#ctf-pwn", { modes: "+ntk hunter2" }),
      makeChannel("oftc", "#linux", { unread: 12 }),
      makeChannel("oftc", "#opers", { modes: "+nts" }),
      makeChannel("rizon", "#hackers", { unread: 8 }),
    ],
    [
      makeQuery("libera", "phrack", { unread: 2 }),
      makeQuery("oftc", "guest"),
      makeQuery("rizon", "nyx", { online: false }),
    ],
  );
}
