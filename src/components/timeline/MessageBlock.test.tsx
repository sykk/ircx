import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { nickColor } from "@/lib/nickColor";
import { DEFAULT_PRESENTATION, type Presentation } from "@/lib/theme";
import { useAppStore } from "@/store";
import { makeMessage } from "./fixtures";
import type { Group } from "./groups";
import { MessageBlock, NICK_RAIL_CHARS } from "./MessageBlock";

function declared(opener = "phrack"): Group {
  return { id: "a", grade: "declared", name: "parser", opener };
}

function block(over: Partial<Parameters<typeof MessageBlock>[0]> = {}) {
  return render(
    <MessageBlock
      messages={[makeMessage({ id: "a", nick: "phrack", text: "tags fail" })]}
      ownNick={null}
      // Follows the nick a case set, so a test that says who the reader is does
      // not also have to say what makes a line loud for them.
      highlight={{ nick: over.ownNick ?? null, words: [], hushed: [] }}
      parentOf={() => undefined}
      onJump={() => {}}
      canTag={false}
      onReact={() => {}}
      onReply={() => {}}
      flashId={null}
      group={null}
      opensGroup={false}
      present={new Set()}
      {...over}
    />,
  );
}

/** The line the run opens with: whoever spoke and when, in the order the reader
 * asked for them in. */
function head(container: HTMLElement): HTMLElement {
  const clock = container.querySelector("time");
  if (!clock) throw new Error("the block drew no clock");
  return clock.parentElement!;
}

function spine(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-spine]");
  if (!found) throw new Error("the block drew no spine");
  return found;
}

describe("the spine", () => {
  /** Hue names the group, and the group is named for whoever opened it. */
  it("takes the colour of whoever opened the group", () => {
    const { container } = block({ group: declared("phrack"), opensGroup: true });

    expect(spine(container).style.borderLeftColor).toBe(nickColor("phrack"));
  });

  it("is not the speaker's colour when somebody else opened the group", () => {
    const { container } = block({ group: declared("kade"), opensGroup: true });

    expect(spine(container).style.borderLeftColor).toBe(nickColor("kade"));
    expect(spine(container).style.borderLeftColor).not.toBe(nickColor("phrack"));
  });

  it("stays neutral for a block in no group", () => {
    const { container } = block();

    expect(spine(container).style.borderLeftColor).toBe("var(--border-strong)");
    expect(spine(container).dataset.spine).toBe("solid");
  });

  it("offers a group's identity from its spine and marks the focused one", () => {
    const chosen: Array<string | null> = [];
    const { container, rerender } = block({
      group: declared(),
      opensGroup: true,
      onFocusGroup: (group) => chosen.push(group),
    });

    fireEvent.click(spine(container));
    expect(chosen).toEqual(["a"]);

    rerender(
      <MessageBlock
        messages={[makeMessage({ id: "a", nick: "phrack", text: "tags fail" })]}
        ownNick={null}
        highlight={{ nick: null, words: [], hushed: [] }}
        parentOf={() => undefined}
        onJump={() => {}}
        canTag={false}
        onReact={() => {}}
        onReply={() => {}}
        flashId={null}
        group={declared()}
        opensGroup
        present={new Set()}
        focusedGroup="a"
        onFocusGroup={(group) => chosen.push(group)}
      />,
    );
    fireEvent.click(spine(container));
    expect(chosen).toEqual(["a", "a"]);
    expect(spine(container).getAttribute("aria-label")).toBe("Show all conversations");
  });

  it("softens a block outside the focused group", () => {
    const { container } = block({ group: declared(), focusedGroup: "another" });

    expect((container.firstElementChild as HTMLElement).style.opacity).toBe(
      "var(--disabled-opacity)",
    );
  });

  /**
   * A mention keeps the spine only where there is no group to lose.
   *
   * The other way round was tried and watched. A reply to you names you —
   * that is what replying on IRC is — so the accent took the second block of
   * every exchange the reader was in, and the hue survived only on
   * conversations between other people. The mention is marked twice over
   * without it: the header line above the run, and the tint on the row.
   */
  it("leaves a grouped run its colour even when it names you", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", text: "sykk: look at this" })],
      ownNick: "sykk",
      group: declared("phrack"),
      opensGroup: true,
    });

    expect(spine(container).style.borderLeftColor).toBe(nickColor("phrack"));
  });

  it("still goes accent when a run naming you belongs to no group", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", text: "sykk: look at this" })],
      ownNick: "sykk",
    });

    expect(spine(container).style.borderLeftColor).toBe("var(--accent)");
  });

  /**
   * The block gap is padding on the grid, so a spine that started below it
   * broke the group's line once per author. Continuing blocks move the gap onto
   * the content column, leaving the spine to span the whole row.
   *
   * Asserted on the mechanism rather than on the pixels because jsdom lays
   * nothing out and cannot see the seam this exists to close.
   */
  it("hands the gap to the content column when it continues a group", () => {
    const continues = block({ group: declared(), opensGroup: false }).container;
    const opens = block({ group: declared(), opensGroup: true }).container;

    const ladder = (root: HTMLElement) => root.firstElementChild as HTMLElement;
    const content = (root: HTMLElement) => ladder(root).lastElementChild as HTMLElement;

    expect(ladder(continues).style.paddingTop).toBe("");
    expect(content(continues).style.paddingTop).toBe("var(--timeline-block-gap)");

    expect(ladder(opens).style.paddingTop).toBe("var(--timeline-block-gap)");
    expect(content(opens).style.paddingTop).toBe("");
  });
});

describe("what a group says in words", () => {
  it("names a declared group once, above the run that opens it", () => {
    const opens = block({ group: declared(), opensGroup: true }).container;
    const continues = block({ group: declared(), opensGroup: false }).container;

    expect(within(opens).getByText("parser")).toBeTruthy();
    expect(within(continues).queryByText("parser")).toBeNull();
  });

  /** Both people are in the blocks below in their own colours, so a caption
   * naming them says nothing new. */
  it("says nothing for an addressed group", () => {
    const { queryByText } = block({
      group: { id: "a", grade: "addressed", name: null, opener: "kade" },
      opensGroup: true,
    });

    // By the opener's name, as the declared-group test asserts presence: the
    // caption is a span, so the old query for a button passed for every grade.
    expect(queryByText(/kade/)).toBeNull();
  });
});

describe("what the reader turned off", () => {
  beforeEach(() => useAppStore.setState({ presentation: DEFAULT_PRESENTATION }));

  function set(change: Partial<Presentation>): void {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, ...change } });
  }

  it("draws no spine, and gives the room it took back to the prose", () => {
    set({ spine: false });
    const { container } = block({ group: declared(), opensGroup: true });
    const ladder = container.firstElementChild as HTMLElement;

    expect(container.querySelector("[data-spine]")).toBeNull();
    expect(ladder.style.gridTemplateColumns).not.toContain("--timeline-spine-gap");
  });

  /* The spine is what spans that gap and says two blocks are one group. With
   * nothing spanning it, closing it would leave them running together for no
   * visible reason. */
  it("keeps the gap between two blocks of one group when there is no spine", () => {
    set({ spine: false });
    const { container } = block({ group: declared(), opensGroup: false });
    const ladder = container.firstElementChild as HTMLElement;

    expect(ladder.style.paddingTop).toBe("var(--timeline-block-gap)");
    expect((ladder.lastElementChild as HTMLElement).style.paddingTop).toBe("");
  });

  it("still names the group it can no longer colour", () => {
    set({ spine: false });
    const { getByText } = block({ group: declared(), opensGroup: true });

    expect(getByText("parser")).toBeTruthy();
  });

  it("prints no clock at all", () => {
    set({ clock: "off" });
    const { container } = block();

    expect(container.querySelector("time")).toBeNull();
  });

  it("makes a quiet clock faint", () => {
    set({ clockEmphasis: "quiet" });
    const { container } = block();

    expect(container.querySelector<HTMLElement>("time")!.style.color).toBe("var(--text-faint)");
  });
});

describe("the nickname at the head of a run", () => {
  beforeEach(() => useAppStore.setState({ presentation: DEFAULT_PRESENTATION }));

  it("is written bare by default", () => {
    const { getByText } = block();

    expect(getByText("phrack")).toBeTruthy();
  });

  it("wears angle brackets when the reader asked for them", () => {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, nickBrackets: true } });
    const { getByText, queryByText } = block();

    expect(getByText("<phrack>")).toBeTruthy();
    expect(queryByText("phrack")).toBeNull();
  });

  it("keeps the written name when nickname colours are off", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickColors: false },
    });
    const { getByText } = block();

    expect(getByText("phrack").style.color).toBe("var(--text-primary)");
  });

  it("opens the head of the run, the clock behind it", () => {
    const { container } = block();

    expect(head(container).firstElementChild!.textContent).toBe("phrack");
    expect(container.querySelector("[data-ui='message-head']")!.textContent).toContain("phrack");
  });

  it("stands behind the clock for a reader who put the time first", () => {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, clockSide: "left" } });
    const { container } = block();

    const [clock, name] = container.querySelector("[data-ui='clock-column']")!.children;
    expect(clock!.tagName).toBe("TIME");
    expect(name!.textContent).toBe("phrack");
    expect(name!.getAttribute("data-ui")).toBe("message-head");
  });

  it("puts the clock before the spine", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, clockSide: "before-spine" },
    });
    const { container } = block();

    const clock = container.querySelector("[data-ui='rail-clock']")!;
    const spine = container.querySelector("[data-spine='solid']")!;
    const content = container.querySelector("[data-ui='message-head']")!.parentElement!;
    expect(clock.querySelector("time")).not.toBeNull();
    expect(container.querySelectorAll("time")).toHaveLength(1);
    expect(clock.getAttribute("style")).toContain("grid-column: 1");
    expect(spine.getAttribute("style")).toContain("grid-column: 3");
    expect(content.getAttribute("style")).toContain("grid-column: 5");
  });
});

describe("the nickname at the rail", () => {
  beforeEach(() =>
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true } }),
  );

  it("draws no rail column by default", () => {
    useAppStore.setState({ presentation: DEFAULT_PRESENTATION });
    const { container } = block();

    expect(container.querySelector("[data-ui='rail-nick']")).toBeNull();
  });

  it("moves the name to a column of its own, and opens no header above the run", () => {
    const { container } = block();

    const rail = container.querySelector<HTMLElement>("[data-ui='rail-nick']")!;
    expect(within(rail).getByText("phrack")).toBeTruthy();
    expect(container.querySelector("[data-ui='message-head']")).toBeNull();
    // Not printed twice: the only "phrack" left is the one in the rail.
    expect(rail.textContent).toBe("phrack");
  });

  /* Right-aligned and cut off rather than resized, so a name longer than the
   * column never moves the spine — the same bargain the clock's column keeps
   * with the widest hour of the day. The column itself carries `text-align:
   * right`, so a short name hugs the spine rather than opening a gap after
   * itself; the name's own box is a *maximum* of `NICK_RAIL_CHARS`, so a
   * short name is not stretched to fill it and a long one is capped rather
   * than truncated by a flex remainder that came up short on a font's own
   * rounding. */
  it("holds the column to a fixed width and elides what does not fit", () => {
    const { container } = block();
    const outer = container.querySelector<HTMLElement>("[data-ui='rail-nick'] span")!;
    const name = outer.querySelector<HTMLElement>("span")!;

    expect(outer.style.width).toBe(`${NICK_RAIL_CHARS}ch`);
    expect(outer.className).toContain("text-right");
    expect(outer.getAttribute("title")).toBe("phrack");
    expect(name.style.maxWidth).toBe(`${NICK_RAIL_CHARS}ch`);
    expect(name.style.width).toBe("");
    expect(name.className).toContain("truncate");
  });

  /* The bracket sits outside the shrinking span, so a name long enough to be
   * cut off still closes with `>` instead of losing it to the ellipsis along
   * with the end of the name. */
  it("wears angle brackets there too, when the reader asked for them", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickBrackets: true },
    });
    const { container } = block();
    const rail = container.querySelector<HTMLElement>("[data-ui='rail-nick']")!;

    expect(rail.textContent).toBe("<phrack>");
    expect(within(rail).getByText("phrack")).toBeTruthy();
  });

  it("keeps both brackets even when the name has to be cut off", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickBrackets: true },
    });
    const { container } = block({
      messages: [
        makeMessage({ id: "a", nick: "a-genuinely-enormous-nickname", text: "tags fail" }),
      ],
    });
    const rail = container.querySelector<HTMLElement>("[data-ui='rail-nick']")!;

    expect(rail.textContent!.startsWith("<")).toBe(true);
    expect(rail.textContent!.endsWith(">")).toBe(true);
  });

  /* The brackets used to come out of the column's own `NICK_RAIL_CHARS`, so a
   * name that fit bare truncated the moment brackets went on — the same
   * width `NICK_RAIL_CHARS`'s own doc comment promises a column wide enough
   * for. The column grows by the brackets' two characters instead, so
   * wearing them never costs the name anything. */
  it("widens the column for the brackets rather than taking the room from the name", () => {
    const bareWidth = (() => {
      const { container, unmount } = block();
      const width = container.querySelector<HTMLElement>("[data-ui='rail-nick'] span")!.style
        .width;
      unmount();
      return width;
    })();

    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickBrackets: true },
    });
    const nickAtTheLimit = "a".repeat(NICK_RAIL_CHARS);
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: nickAtTheLimit, text: "tags fail" })],
    });
    const rail = container.querySelector<HTMLElement>("[data-ui='rail-nick']")!;
    const outer = rail.querySelector<HTMLElement>("span")!;

    expect(bareWidth).toBe(`${NICK_RAIL_CHARS}ch`);
    expect(outer.style.width).toBe(`${NICK_RAIL_CHARS + 2}ch`);
    // A nick exactly at the limit is exactly what the column promises room
    // for, so wearing brackets on top of it must not truncate it.
    expect(rail.textContent).toBe(`<${nickAtTheLimit}>`);
  });

  /**
   * The truncation regression, held down structurally: the name's box caps
   * itself at `NICK_RAIL_CHARS` on its own terms, in both directions, rather
   * than being whatever is left of a shared flex row after the brackets take
   * theirs.
   *
   * jsdom lays nothing out, so this cannot assert that the sixteenth
   * character is actually painted — a flex-shrink split reported the same
   * `textContent` and the same declared widths in this environment and still
   * clipped two real characters in a browser, on nothing this suite could
   * see. What it can hold is the one fact that made the browser fix work:
   * the name's own bound never moves when its sibling brackets appear.
   */
  it("gives the name the same bound whether or not it wears brackets", () => {
    const bare = block({ messages: [makeMessage({ id: "a", nick: "phrack", text: "hi" })] });
    const bareName = bare.container.querySelector<HTMLElement>(
      "[data-ui='rail-nick'] span span",
    )!;
    expect(bareName.style.maxWidth).toBe(`${NICK_RAIL_CHARS}ch`);
    bare.unmount();

    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickBrackets: true },
    });
    const bracketed = block({ messages: [makeMessage({ id: "a", nick: "phrack", text: "hi" })] });
    const bracketedName = bracketed.container.querySelector<HTMLElement>(
      "[data-ui='rail-nick'] span span",
    )!;
    expect(bracketedName.style.maxWidth).toBe(`${NICK_RAIL_CHARS}ch`);
  });

  /**
   * The grouping regression: a *maximum* rather than a fixed width lets a
   * short name stay its own natural size instead of being stretched to
   * sixteen characters of box, which is exactly what opened a gap between
   * `<` and the name it belongs to — the bracket stayed pinned to the left
   * of the column while the name's forced-wide box, right-aligned only
   * *inside itself*, floated the real letters off to the right of it.
   * `text-align: right` on the column is what closes that gap: the whole
   * `<name>` run is one right-aligned unit now, so what is left over for a
   * short name opens up before the `<` instead of splitting the name from
   * its own bracket.
   */
  it("does not stretch a short name, so it groups with its brackets rather than splitting from them", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickBrackets: true },
    });
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "syk", text: "hi" })],
    });
    const outer = container.querySelector<HTMLElement>("[data-ui='rail-nick'] span")!;
    const name = outer.querySelector<HTMLElement>("span")!;

    expect(outer.className).toContain("text-right");
    expect(name.style.width).toBe("");
    expect(name.style.maxWidth).toBe(`${NICK_RAIL_CHARS}ch`);
    // The whole run reads as one word with nothing splitting the bracket
    // from the name it closes over.
    expect(outer.textContent).toBe("<syk>");
  });

  /* The clock followed the name to the rail, having nowhere left beside it in
   * the content column — `before-spine` puts it ahead of the name, and every
   * other side puts it after, still short of the spine. */
  it("sends the clock along to the rail, ahead of the name for before-spine", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, clockSide: "before-spine" },
    });
    const { container } = block();

    const clock = container.querySelector("[data-ui='rail-clock']")!;
    const nick = container.querySelector("[data-ui='rail-nick']")!;
    const spine = container.querySelector("[data-spine='solid']")!;
    expect(container.querySelectorAll("time")).toHaveLength(1);
    expect(clock.getAttribute("style")).toContain("grid-column: 1");
    expect(nick.getAttribute("style")).toContain("grid-column: 3");
    expect(spine.getAttribute("style")).toContain("grid-column: 5");
  });

  it("puts the clock after the name for every other side, still ahead of the spine", () => {
    const { container } = block();

    const clock = container.querySelector("[data-ui='rail-clock']")!;
    const nick = container.querySelector("[data-ui='rail-nick']")!;
    const spine = container.querySelector("[data-spine='solid']")!;
    expect(nick.getAttribute("style")).toContain("grid-column: 1");
    expect(clock.getAttribute("style")).toContain("grid-column: 3");
    expect(spine.getAttribute("style")).toContain("grid-column: 5");
  });

  it("draws no clock at all when the reader turned it off", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, clock: "off" },
    });
    const { container } = block();

    expect(container.querySelector("[data-ui='rail-clock']")).toBeNull();
    expect(container.querySelector("time")).toBeNull();
    const nick = container.querySelector("[data-ui='rail-nick']")!;
    expect(nick.getAttribute("style")).toContain("grid-column: 1");
  });

  /* The prefix already names every line; a rail column with nothing in it
   * would be a second, empty promise of the same information. */
  it("opens an empty column for a run naming its sender on every line", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickAtRail: true, nickEveryLine: true },
    });
    const { container } = block();

    const rail = container.querySelector("[data-ui='rail-nick']")!;
    expect(rail.textContent).toBe("");
  });
});

/* The clock in front used to leave the lines of the run starting at the rail,
 * under the time rather than under the name. They are set beside it now. */
describe("the column a leading clock opens", () => {
  beforeEach(() =>
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, clockSide: "left" },
    }),
  );

  function column(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>("[data-ui='clock-column']");
  }

  it("puts the lines of the run in the column the name is in", () => {
    const { container } = block();
    const rows = container.querySelector<HTMLElement>("[data-ui='message-row']")!;

    expect(column(container)!.style.gridTemplateColumns).toBe("max-content minmax(0, 1fr)");
    expect(rows.parentElement!.style.gridColumn).toBe("2");
  });

  /* Half the day prints a two-digit hour in the 12-hour formats, and a column
   * sized to what this block happens to print would move the whole
   * conversation's left edge when the hour rolled over. */
  it("holds the clock to the widest its format prints", () => {
    const { container, unmount } = block();
    expect(container.querySelector("time")!.style.minWidth).toBe("5ch");

    unmount();
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, clockSide: "left", clock: "12h" },
    });

    expect(block().container.querySelector("time")!.style.minWidth).toBe("8ch");
  });

  it("draws no column when the clock prints nothing", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, clockSide: "left", clock: "off" },
    });
    const { container } = block();

    expect(column(container)).toBeNull();
  });

  /* The name in front keeps the layout it had: the prose already started under
   * it, and a column would be room reserved for nothing. */
  it("is not drawn when the name comes first", () => {
    useAppStore.setState({ presentation: DEFAULT_PRESENTATION });
    const { container } = block();

    expect(column(container)).toBeNull();
  });

  it("is not drawn for a run whose lines name their own sender", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", kind: "action", text: "waves" })],
    });

    expect(column(container)).toBeNull();
    expect(container.textContent).toContain("* phrack waves");
  });
});

describe("the nickname in front of every line", () => {
  beforeEach(() =>
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickEveryLine: true },
    }),
  );

  const said = [
    makeMessage({ id: "a", nick: "phrack", text: "hi" }),
    makeMessage({ id: "b", nick: "phrack", text: "how are you?" }),
  ];

  function rows(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("[data-ui='message-row']")];
  }

  it("names the sender on each of them", () => {
    const { getAllByText } = block({ messages: said });

    expect(getAllByText("phrack")).toHaveLength(2);
  });

  /* The head of the run is what the prefix replaces. Left standing it would
   * state the name and the time a third time for a two-line run. */
  it("draws no head above the run, and puts its clock on each line", () => {
    const { container } = block({ messages: said });

    expect(rows(container).every((row) => row.querySelector("time") !== null)).toBe(true);
    expect(container.querySelectorAll("time")).toHaveLength(2);
  });

  /* Copied out of the window as well as read in it: the separator is a
   * character in the line rather than a margin between two elements. */
  it("closes the name with a colon, or with the brackets when it wears them", () => {
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, nickEveryLine: true, clockSide: "left" },
    });
    const { container, unmount } = block({ messages: said });
    expect(container.textContent).toContain("phrack: hi");

    unmount();
    useAppStore.setState({
      presentation: {
        ...DEFAULT_PRESENTATION,
        nickEveryLine: true,
        nickBrackets: true,
        clockSide: "left",
      },
    });
    const bracketed = block({ messages: said });

    expect(bracketed.getAllByText("<phrack>")).toHaveLength(2);
    expect(bracketed.container.textContent).not.toContain("phrack:");
    expect(bracketed.container.textContent).toContain("<phrack> hi");
  });

  /* An action and a notice write the sender into the body themselves. A prefix
   * in front of one of those names them twice on the same line. */
  it("leaves an action to write its own nick", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", kind: "action", text: "waves" })],
    });

    expect(container.textContent).toContain("* phrack waves");
    expect(container.textContent).not.toContain("phrack:");
  });
});

describe("a compact single-message run", () => {
  beforeEach(() =>
    useAppStore.setState({
      presentation: { ...DEFAULT_PRESENTATION, compactSingletons: true },
    }),
  );

  it("puts the sender and clock in front of an ordinary message", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", text: "hi" })],
    });

    expect(container.textContent).toContain("phrack");
    expect(container.textContent).toMatch(/phrack \d{2}:\d{2}: hi/);
    expect(container.querySelectorAll("time")).toHaveLength(1);
  });

  it("keeps a multi-message run under one header", () => {
    const { container, getAllByText } = block({
      messages: [
        makeMessage({ id: "a", nick: "phrack", text: "hi" }),
        makeMessage({ id: "b", nick: "phrack", text: "again" }),
      ],
    });

    expect(getAllByText("phrack")).toHaveLength(1);
    expect(container.textContent).not.toContain("phrack: hi");
  });
});

describe("conversation position", () => {
  it("centers the bounded block by default", () => {
    const { container } = block();

    expect((container.firstElementChild as HTMLElement).style.marginInline).toBe("auto");
  });

  it("returns the block to the rail when asked", () => {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, align: "rail" } });
    const { container } = block();

    expect((container.firstElementChild as HTMLElement).style.marginInline).toBe("");
  });
});

describe("message text size", () => {
  it("uses the size chosen in Appearance", () => {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, messageSize: "15px" } });
    const { container } = block();

    expect(container.querySelector<HTMLElement>("[data-ui='message-row']")!.style.fontSize).toBe(
      "15px",
    );
  });
});

describe("a declared name is not printed twice", () => {
  it("keeps the bracket out of the body", () => {
    const { getByText, queryByText } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", text: "[parser] tags fail" })],
      group: declared(),
      opensGroup: true,
    });

    expect(getByText("tags fail")).toBeTruthy();
    expect(queryByText("[parser] tags fail")).toBeNull();
  });
});
