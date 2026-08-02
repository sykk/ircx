import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTarget,
  makeChannel,
  makeNetwork,
  makeQuery,
  oneView,
  resetStore,
  seedStore,
} from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import { openFirstConversation } from "./firstPane";

beforeEach(resetStore);

/** How many panes the window holds, the layout being a tree of them. */
function panes(): number {
  return useAppStore.getState().viewOrder.length;
}

/**
 * #343: a pane was only ever opened by a person, so a profile that connects and
 * joins its channels on its own read "No conversation open" beside a sidebar
 * listing them.
 */
describe("the first conversation in an empty window", () => {
  it("opens the one there already is", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);

    const stop = openFirstConversation();

    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    stop();
  });

  /** The case a first launch is: onboarding saves the network, the connection
   * starts, and the autojoin lands after everything at startup has run. */
  it("waits for one to arrive", () => {
    seedStore([makeNetwork("libera")]);
    const stop = openFirstConversation();
    expect(panes()).toBe(0);

    useAppStore.getState().applyEvent({
      type: "channelUpdated",
      channel: makeChannel("libera", "#ctf-ops"),
    });

    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    stop();
  });

  it("opens nothing where there is nothing to open", () => {
    seedStore([makeNetwork("libera")]);

    const stop = openFirstConversation();

    expect(panes()).toBe(0);
    stop();
  });

  /** A person who has a pane has the window. The stored layout is restored
   * before this is armed, so a restart that brought its panes back arrives
   * here with one. */
  it("leaves a window that already has a pane alone", () => {
    seedStore([makeNetwork("libera")], [makeChannel("libera", "#ctf-ops")]);
    useAppStore.setState(oneView({ network: "libera", target: "#hackint" }));

    const stop = openFirstConversation();

    expect(activeTarget()).toEqual({ network: "libera", target: "#hackint" });
    expect(panes()).toBe(1);
    stop();
  });

  it("opens no second pane as the rest of an autojoin arrives", () => {
    seedStore([makeNetwork("libera")]);
    const stop = openFirstConversation();

    for (const name of ["#ctf-ops", "#ctf-web", "#hackint"]) {
      useAppStore.getState().applyEvent({
        type: "channelUpdated",
        channel: makeChannel("libera", name),
      });
    }

    expect(panes()).toBe(1);
    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    stop();
  });
});

describe("which conversation that is", () => {
  /** An autojoin is acknowledged in whatever order the server gets to it and
   * arrives as one batch, which the bridge applies in one write. What opens is
   * the row at the top of the sidebar rather than the first line off the
   * socket. */
  it("takes the top of the sidebar out of a batch of joins", () => {
    seedStore([makeNetwork("libera"), makeNetwork("oftc")]);
    const stop = openFirstConversation();

    useAppStore.getState().applyEvents([
      { type: "channelUpdated", channel: makeChannel("oftc", "#linux") },
      { type: "channelUpdated", channel: makeChannel("libera", "#hackint") },
      { type: "channelUpdated", channel: makeChannel("libera", "#ctf-ops") },
    ]);

    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    stop();
  });

  it("falls back to a query where no network has a channel", () => {
    seedStore([makeNetwork("libera")], [], [makeQuery("libera", "phrack")]);

    const stop = openFirstConversation();

    expect(activeTarget()).toEqual({ network: "libera", target: "phrack" });
    stop();
  });
});
