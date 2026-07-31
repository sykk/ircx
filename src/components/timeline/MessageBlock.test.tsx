import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nickColor } from "@/lib/nickColor";
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
      parentOf={() => undefined}
      onJump={() => {}}
      canTag={false}
      onReact={() => {}}
      onReply={() => {}}
      flashId={null}
      group={null}
      opensGroup={false}
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
    const { container } = block({
      group: { id: "a", grade: "addressed", name: null, opener: "kade" },
      opensGroup: true,
    });

    expect(container.querySelector("button")).toBeNull();
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
