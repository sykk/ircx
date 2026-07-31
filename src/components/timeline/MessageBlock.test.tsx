import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { nickColor } from "@/lib/nickColor";
import { makeMessage } from "./fixtures";
import type { Group } from "./groups";
import { MessageBlock } from "./MessageBlock";

function declared(opener = "phrack"): Group {
  return { id: "a", grade: "declared", name: "parser", opener };
}

function guessed(opener = "nyx"): Group {
  return { id: "a", grade: "guessed", name: null, opener };
}

function block(over: Partial<Parameters<typeof MessageBlock>[0]> = {}) {
  return render(
    <MessageBlock
      messages={[makeMessage({ id: "a", nick: "phrack", text: "tags fail" })]}
      ownNick={null}
      parentOf={() => undefined}
      onJump={() => {}}
      canTag={false}
      onReact={() => {}}
      onReply={() => {}}
      flashId={null}
      group={null}
      opensGroup={false}
      onDismissGroup={() => {}}
      {...over}
    />,
  );
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

  /** Stroke ranks certainty. Nothing else in the timeline is dashed, so dashed
   * can only ever mean the client grouped this and could be wrong. */
  it("is dashed only for a guess", () => {
    expect(spine(block({ group: guessed(), opensGroup: true }).container).dataset.spine).toBe(
      "dashed",
    );
    expect(spine(block({ group: declared(), opensGroup: true }).container).dataset.spine).toBe(
      "solid",
    );
  });

  /** A mention has nowhere else to go; a group's colour survives in the blocks
   * either side of the one that broke it. */
  it("goes accent when the run names you, whatever group it is in", () => {
    const { container } = block({
      messages: [makeMessage({ id: "a", nick: "phrack", text: "sykk: look at this" })],
      ownNick: "sykk",
      group: declared("phrack"),
      opensGroup: true,
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
    const { container } = block({
      group: { id: "a", grade: "addressed", name: null, opener: "kade" },
      opensGroup: true,
    });

    expect(container.querySelector("button")).toBeNull();
  });

  /** Only a guess can be undone, so the offer to undo is what tells the reader
   * the client did this — no sentence explaining the heuristic. */
  it("offers a way out of a guess, and only of a guess", () => {
    const onDismissGroup = vi.fn();
    const guess = block({ group: guessed(), opensGroup: true, onDismissGroup }).container;
    const fact = block({ group: declared(), opensGroup: true }).container;

    fireEvent.click(within(guess).getByText("not a group"));

    expect(onDismissGroup).toHaveBeenCalledWith("a");
    expect(within(fact).queryByText("not a group")).toBeNull();
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
