import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { nickColor } from "@/lib/nickColor";
import { DEFAULT_PRESENTATION, type Presentation } from "@/lib/theme";
import { useAppStore } from "@/store";
import { makeMessage } from "./fixtures";
import type { Group } from "./groups";
import { MessageBlock } from "./MessageBlock";

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
      highlight={{ nick: over.ownNick ?? null, words: [] }}
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
        highlight={{ nick: null, words: [] }}
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
   * Asserted on the mechanism rather than on the pixels: jsdom lays nothing
   * out, so nothing here can see the seam this exists to close. The screenshot
   * in `docs/manual-verification.md` is what saw it.
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
  });

  it("stands behind the clock for a reader who put the time first", () => {
    useAppStore.setState({ presentation: { ...DEFAULT_PRESENTATION, clockSide: "left" } });
    const { container } = block();

    const [first, second] = head(container).children;
    expect(first!.tagName).toBe("TIME");
    expect(second!.textContent).toBe("phrack");
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
