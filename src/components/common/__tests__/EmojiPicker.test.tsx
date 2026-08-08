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

  it("saves favorites from the star control", () => {
    render(<EmojiPicker onPick={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "eggplant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Eggplant to favorites" }));

    fireEvent.change(screen.getByLabelText("Search emoji"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Favorites" }));
    expect(screen.getByRole("button", { name: "Eggplant" })).toBeTruthy();
  });
});
