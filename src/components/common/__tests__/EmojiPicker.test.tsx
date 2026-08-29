import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "@/components/common/EmojiPicker";

beforeEach(() => {
  localStorage.clear();
});

describe("EmojiPicker", () => {
  it("searches all emoji", () => {
    render(<EmojiPicker onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "eggplant" } });
    expect(screen.getByRole("button", { name: "Eggplant" })).toBeTruthy();
  });

  it("records recents when an emoji is picked", () => {
    const onPick = vi.fn();
    render(<EmojiPicker onPick={onPick} />);
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "eggplant" } });
    fireEvent.click(screen.getByRole("button", { name: "Eggplant" }));

    expect(onPick).toHaveBeenCalledWith("🍆");
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    expect(screen.getByRole("button", { name: "Eggplant" })).toBeTruthy();
  });

  it("opens the full catalog when recents contain only one emoji", () => {
    localStorage.setItem("ircx.emoji.recents", JSON.stringify(["👍"]));

    render(<EmojiPicker onPick={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "Smileys & people" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  // Tailwind wraps `group-hover:` in `@media (hover: hover)`, so a machine
  // without a pointer never matches it, and `opacity-0` hides the focus ring
  // along with the glyph. A star revealed only that way is a control somebody
  // tabbing onto cannot see.
  it("reveals an unset star to the keyboard wherever it reveals it to the pointer", () => {
    render(<EmojiPicker onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "eggplant" } });
    const star = screen.getByRole("button", { name: "Add Eggplant to favorites" });

    expect(star.className).toContain("group-hover:opacity-100");
    expect(star.className).toContain("group-focus-within:opacity-100");
  });

  it("saves favorites from the star control", () => {
    render(<EmojiPicker onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "eggplant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Eggplant to favorites" }));

    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Favorites" }));
    expect(screen.getByRole("button", { name: "Eggplant" })).toBeTruthy();
  });
});
