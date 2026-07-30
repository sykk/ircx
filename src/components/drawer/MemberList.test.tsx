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

function show(members = CTF_OPS_MEMBERS) {
  return render(<MemberList members={members} selected={null} onSelect={vi.fn()} />);
}

function memberButtons() {
  return screen.queryAllByRole("button");
}

/** A row's presence dot, which is its only aria-hidden child. */
function dot(nick: RegExp): HTMLElement {
  const found = screen.getByRole("button", { name: nick }).querySelector("[aria-hidden]");
  if (!found) throw new Error(`no presence dot on the ${String(nick)} row`);
  return found as HTMLElement;
}

/** One group of `count` unprivileged nicks, so the truncation row lands in a
 * predictable place. */
function plain(count: number) {
  return Array.from({ length: count }, (_, i) => member(`nick${i}`));
}

describe("MemberList", () => {
  it("heads two groups with their counts, folding voice into members", () => {
    show();
    expect(screen.getByRole("heading", { name: /operators/i }).textContent).toContain(
      "4",
    );
    expect(screen.getByRole("heading", { name: /members/i }).textContent).toContain("12");
    expect(screen.queryByRole("heading", { name: /voiced/i })).toBeNull();

    // A voiced member sits in members and still carries its sigil.
    expect(
      within(screen.getByRole("button", { name: /phrack/ })).getByText("+"),
    ).toBeTruthy();
  });

  it("shows the top prefix as the row's sigil", () => {
    show([
      member("Ariel", { prefixes: ["~", "@", "+"] }),
      member("sable", { prefixes: ["@"] }),
      member("guest41"),
    ]);
    expect(
      within(screen.getByRole("button", { name: /Ariel/ })).getByText("~"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /sable/ })).getByText("@"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /guest41/ })).queryByText("+"),
    ).toBeNull();
  });

  it("puts the away reason on the row and dims the nick", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "… and 2 more" }));

    const wren = screen.getByRole("button", { name: /wren/ });
    expect(wren).toHaveProperty("title", "Away: sleep");
    expect(within(wren).getByText("wren").className).toContain("--text-muted");
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
    expect(screen.getByRole("button", { name: /nyx/ })).toHaveProperty(
      "title",
      "Away: away",
    );
  });

  it("truncates the members group and reveals the rest on demand", () => {
    show(plain(15));
    expect(screen.getAllByRole("button", { name: /^nick/ })).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "… and 5 more" }));

    expect(screen.getAllByRole("button", { name: /^nick/ })).toHaveLength(15);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("never hides an operator behind the truncation", () => {
    show(plain(15).map((m) => ({ ...m, prefixes: ["@"] })));

    expect(screen.getAllByRole("button", { name: /^nick/ })).toHaveLength(15);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("renders a window of a several-thousand member channel", () => {
    show(plain(3000));
    fireEvent.click(screen.getByRole("button", { name: "… and 2990 more" }));

    expect(memberButtons().length).toBeLessThan(100);
    expect(memberButtons().length).toBeGreaterThan(0);
  });
});
