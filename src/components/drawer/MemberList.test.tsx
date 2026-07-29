import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemberList } from "./MemberList";
import { CTF_OPS_MEMBERS, crowd, member } from "./fixtures";

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

describe("MemberList", () => {
  it("heads each group with its count", () => {
    show();
    expect(screen.getByRole("heading", { name: /operators/i }).textContent).toContain(
      "4",
    );
    expect(screen.getByRole("heading", { name: /voiced/i }).textContent).toContain("3");
    expect(screen.getByRole("heading", { name: /members/i }).textContent).toContain("9");
  });

  it("shows the prefixes the server sent, however many arrived", () => {
    show([
      member("Ariel", { prefixes: ["~", "@", "+"] }),
      member("sable", { prefixes: ["@"] }),
    ]);
    expect(
      within(screen.getByRole("button", { name: /Ariel/ })).getByText("~@+"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /sable/ })).getByText("@"),
    ).toBeTruthy();
  });

  it("puts the away reason on the row and dims the nick", () => {
    show();
    const wren = screen.getByRole("button", { name: /wren/ });
    expect(wren).toHaveProperty("title", "Away: sleep");
    expect(within(wren).getByText("wren").className).toContain("--text-muted");
  });

  it("falls back to a bare away label when the server gave no reason", () => {
    show();
    expect(screen.getByRole("button", { name: /nyx/ })).toHaveProperty(
      "title",
      "Away: away",
    );
  });

  it("badges an account and names it when it differs from the nick", () => {
    show();
    expect(
      within(screen.getByRole("button", { name: /fox/ })).getByText("vulpes"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /kade/ })).getByText("account"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: /guest41/ })).queryByText("account"),
    ).toBeNull();
  });

  it("narrows to the filter, matching nick or account", () => {
    show();
    fireEvent.change(screen.getByLabelText("Filter members"), {
      target: { value: "vulpes" },
    });
    expect(memberButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /fox/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /operators/i })).toBeNull();
  });

  it("says so when the filter matches nobody", () => {
    show();
    fireEvent.change(screen.getByLabelText("Filter members"), {
      target: { value: "nobodyhere" },
    });
    expect(screen.getByText('No member matches "nobodyhere"')).toBeTruthy();
  });

  it("renders a window of a several-thousand member channel", () => {
    show(crowd(3000));
    expect(memberButtons().length).toBeLessThan(100);
    expect(memberButtons().length).toBeGreaterThan(0);
  });
});
