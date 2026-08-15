import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemberList } from "./MemberList";
import { CTF_OPS_MEMBERS, member } from "./fixtures";

/* The virtualiser sizes itself from the scroll container, which jsdom reports
 * as zero high. Without a height it renders no rows at all. */
const nativeOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
});

afterAll(() => {
  if (nativeOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", nativeOffsetHeight);
  }
});

function show(members = CTF_OPS_MEMBERS, filter = "") {
  return render(
    <MemberList members={members} onSelect={vi.fn()} onMenu={vi.fn()} filter={filter} />,
  );
}

function memberButtons() {
  return screen.queryAllByRole("listitem");
}

/** A row's presence dot, which is its only aria-hidden child. */
function dot(nick: RegExp): HTMLElement {
  const found = screen.getByRole("listitem", { name: nick }).querySelector("[aria-hidden]");
  if (!found) throw new Error(`no presence dot on the ${String(nick)} row`);
  return found as HTMLElement;
}

/** One group of `count` unprivileged nicks, so the truncation row lands in a
 * predictable place. */
function plain(count: number) {
  return Array.from({ length: count }, (_, i) => member(`nick${i}`));
}

describe("MemberList", () => {
  it("selects a member on left-click and opens actions on right-click", () => {
    const onSelect = vi.fn();
    const onMenu = vi.fn();
    render(<MemberList members={[member("sable")]} onSelect={onSelect} onMenu={onMenu} filter="" />);
    const row = screen.getByRole("listitem", { name: "sable" });

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ nick: "sable" }));
    expect(onMenu).not.toHaveBeenCalled();

    fireEvent.contextMenu(row, { clientX: 42, clientY: 64 });
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ nick: "sable" }), 42, 64);
  });

  it("opens member actions from the keyboard context-menu chord", () => {
    const onMenu = vi.fn();
    render(<MemberList members={[member("sable")]} onSelect={vi.fn()} onMenu={onMenu} filter="" />);

    fireEvent.keyDown(screen.getByRole("listitem", { name: "sable" }), {
      key: "F10",
      shiftKey: true,
    });

    expect(onMenu).toHaveBeenCalledOnce();
  });

  it.each(["Enter", " "])("selects a focused member with %s", (key) => {
    const onSelect = vi.fn();
    render(
      <MemberList
        members={[member("sable")]}
        onSelect={onSelect}
        onMenu={vi.fn()}
        filter=""
      />,
    );

    fireEvent.keyDown(screen.getByRole("listitem", { name: "sable" }), { key });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ nick: "sable" }));
  });

  it("heads two groups with their counts, folding voice into members", () => {
    show();
    expect(screen.getByRole("heading", { name: /operators/i }).textContent).toContain(
      "4",
    );
    expect(screen.getByRole("heading", { name: /members/i }).textContent).toContain("12");
    expect(screen.queryByRole("heading", { name: /voiced/i })).toBeNull();

    // A voiced member sits in members and still carries its sigil.
    expect(
      within(screen.getByRole("listitem", { name: /phrack/ })).getByText("+"),
    ).toBeTruthy();
  });

  it("shows the top prefix as the row's sigil", () => {
    show([
      member("Ariel", { prefixes: ["~", "@", "+"] }),
      member("sable", { prefixes: ["@"] }),
      member("guest41"),
    ]);
    expect(
      within(screen.getByRole("listitem", { name: /Ariel/ })).getByText("~"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: /sable/ })).getByText("@"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: /guest41/ })).queryByText("+"),
    ).toBeNull();
  });

  it("puts the away reason on the row and dims the nick", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "… and 2 more" }));

    const wren = screen.getByRole("listitem", { name: /wren/ });
    expect(wren).toHaveProperty("title", "Away: sleep");
    expect(within(wren).getByText("wren").className).toContain("--text-muted");
  });

  /** #352: the column stops at 13rem, so a long enough nick truncates and the
   * inspector truncates it again. Nothing gave the whole of it back — the row
   * carried a title only for somebody away. */
  it("keeps the whole nick on the element that clips it", () => {
    show([member("wallabywombatthelongest")]);

    const name = screen.getByText("wallabywombatthelongest");
    expect(name.className).toContain("truncate");
    expect(name).toHaveProperty("title", "wallabywombatthelongest");
  });

  /** The button's own title is the away reason and stays that: it is where the
   * state belongs, and it is what the row is announced with. */
  it("leaves the away reason where it was", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "… and 2 more" }));

    const wren = screen.getByRole("listitem", { name: /wren/ });
    expect(wren).toHaveProperty("title", "Away: sleep");
    expect(within(wren).getByText("wren")).toHaveProperty("title", "wren");
  });

  it("hollows the presence dot for an away member rather than fading it", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "… and 2 more" }));

    expect(dot(/wren/).className).toContain("border-[1.5px]");
    expect(dot(/phrack/).className).not.toContain("border-");
    for (const nick of [/wren/, /phrack/]) {
      expect(dot(nick).className).not.toContain("opacity");
    }
  });

  it("falls back to a bare away label when the server gave no reason", () => {
    show();
    expect(screen.getByRole("listitem", { name: /nyx/ })).toHaveProperty(
      "title",
      "Away: away",
    );
  });

  it("truncates the members group and reveals the rest on demand", () => {
    show(plain(15));
    expect(screen.getAllByRole("listitem", { name: /^nick/ })).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "… and 5 more" }));

    expect(screen.getAllByRole("listitem", { name: /^nick/ })).toHaveLength(15);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("never hides an operator behind the truncation", () => {
    show(plain(15).map((m) => ({ ...m, prefixes: ["@"] })));

    expect(screen.getAllByRole("listitem", { name: /^nick/ })).toHaveLength(15);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("renders a window of a several-thousand member channel", () => {
    show(plain(3000));
    fireEvent.click(screen.getByRole("button", { name: "… and 2990 more" }));

    expect(memberButtons().length).toBeLessThan(100);
    expect(memberButtons().length).toBeGreaterThan(0);
  });
});

/** #482. The roster draws ten members and `… and n more`, so the filter is the
 * only way to see the other 390 without scrolling all of them. */
describe("a filtered MemberList", () => {
  it("draws only the names carrying the filter", () => {
    show(CTF_OPS_MEMBERS, "ra");

    expect(screen.getByRole("listitem", { name: /phrack/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /spiral/ })).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: /marrow/ })).toBeNull();
  });

  it("counts the matches in the group heading, not the channel", () => {
    show(CTF_OPS_MEMBERS, "ra");

    expect(screen.getByRole("heading", { name: "Members — 2" })).toBeTruthy();
  });

  /* The whole of it: a filter reading only the ten members already on screen
   * would answer for those ten and not for the channel.
   *
   * `nick39` matches eleven — itself and `nick390` through `nick399` — which is
   * one more than `MEMBERS_PREVIEW`, so the truncation has something to hide.
   * A filter matching ten or fewer would pass whether or not it was bypassed. */
  it("reaches past the truncation without being expanded", () => {
    show(plain(400), "nick39");

    expect(screen.getAllByRole("listitem", { name: /^nick39/ })).toHaveLength(11);
    expect(screen.getByRole("listitem", { name: "nick399" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("puts the truncation back when the filter is emptied", () => {
    const { rerender } = show(plain(15), "nick1");
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();

    rerender(<MemberList members={plain(15)} onSelect={vi.fn()} onMenu={vi.fn()} filter="" />);

    expect(screen.getByRole("button", { name: "… and 5 more" })).toBeTruthy();
  });

  it("says who was looked for when nobody matches", () => {
    show(CTF_OPS_MEMBERS, "zzz");

    expect(screen.getByText("Nobody matching zzz")).toBeTruthy();
    expect(screen.queryByText("No members")).toBeNull();
  });
});
