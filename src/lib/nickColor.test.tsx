import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { member } from "@/components/drawer/fixtures";
import { MemberRow } from "@/components/drawer/MemberRow";
import { makeMessage } from "@/components/timeline/fixtures";
import { MessageBlock } from "@/components/timeline/MessageBlock";
import { nickColor, nickColorIndex, PALETTE_SIZE } from "./nickColor";

describe("nickColor", () => {
  it("returns the same colour for the same nick", () => {
    expect(nickColor("sable")).toBe(nickColor("sable"));
  });

  it("ignores case, because IRC nicks do", () => {
    expect(nickColorIndex("Sable")).toBe(nickColorIndex("sable"));
    expect(nickColorIndex("SABLE")).toBe(nickColorIndex("sable"));
  });

  it("stays inside the declared palette", () => {
    for (const nick of ["a", "sable", "phrack", "nyx", "kade", "pwn-300", "[bot]", ""]) {
      const index = nickColorIndex(nick);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(PALETTE_SIZE);
    }
  });

  it("emits a token reference rather than a colour", () => {
    expect(nickColor("sable")).toMatch(/^var\(--nick-([1-9]|10)\)$/);
  });

  it("spreads a realistic member list over the whole palette", () => {
    const nicks = Array.from({ length: 200 }, (_, i) => `user${i}`);
    const used = new Set(nicks.map(nickColorIndex));
    expect(used.size).toBe(PALETTE_SIZE);
  });

  // Pinned values, not a restatement of the algorithm. The member list and the
  // timeline must agree on every nick; changing the hash renumbers everyone and
  // has to be a deliberate edit to this list.
  it("assigns the indices every surface has to agree on", () => {
    expect(
      ["sable", "phrack", "nyx", "kade", "marrow", "wren", "jolt", "spiral"].map(nickColorIndex),
    ).toEqual([10, 4, 2, 6, 5, 5, 2, 2]);
  });
});

/** The `var(--nick-N)` an element's inline style asks for, whichever property
 * it sets it on: the roster paints a dot and the timeline paints text. */
function token(element: Element | null | undefined): string {
  const match = /var\(--nick-\d+\)/.exec(element?.getAttribute("style") ?? "");
  if (!match) throw new Error(`no nick colour on ${element?.outerHTML ?? "nothing"}`);
  return match[0];
}

// Colour links a roster entry to a message block and does nothing else, so
// these two renders agreeing is the whole feature. #22 collapsed a second hash
// in the drawer onto this module; this fails if one comes back.
describe("nick colour across surfaces", () => {
  it.each(["sable", "phrack", "nyx", "kade", "marrow", "Ariel", "pwn-300", "guest41"])(
    "paints %s the same in the member list and the timeline",
    (nick) => {
      const roster = render(
        <MemberRow member={member(nick)} selected={false} onSelect={() => {}} />,
      );
      // The block, because that is where the name is written: once, at the head
      // of its author's run.
      const timeline = render(
        <MessageBlock
          messages={[makeMessage({ nick })]}
          ownNick={null}
          parentOf={() => undefined}
          onJump={() => {}}
          canTag={false}
          onReact={() => {}}
          onReply={() => {}}
          flashId={null}
          group={null}
          opensGroup={false}
          present={new Set()}
        />,
      );

      const dot = roster.container.querySelector('span[aria-hidden="true"]');
      const name = within(timeline.container).getByText(nick);
      expect(token(dot)).toBe(token(name));
    },
  );
});
