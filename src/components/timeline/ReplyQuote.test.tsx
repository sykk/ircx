import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeMessage } from "./fixtures";
import { ReplyQuote } from "./ReplyQuote";

function quote(text: string) {
  const parent = makeMessage({ id: "p", nick: "phrack", text });
  render(<ReplyQuote msgid="p" parent={parent} onJump={vi.fn()} />);
  return screen.getByRole("button");
}

describe("ReplyQuote", () => {
  it("flattens the excerpt to text, carrying neither syntax nor emphasis", () => {
    const button = quote("**do not** rerun the exploit against ~~staging~~ prod");

    expect(button.textContent).toContain("do not rerun the exploit against staging prod");
    expect(button.textContent).not.toContain("**");
    expect(button.querySelector("strong")).toBe(null);
    expect(button.querySelector("s")).toBe(null);
  });

  it("keeps what a code span says without the backticks that said it", () => {
    const button = quote("try `strings ./pwn-300` first");

    expect(button.textContent).toContain("try strings ./pwn-300 first");
    expect(button.querySelector("code")).toBe(null);
  });

  it("leaves a bare URL alone, because the subset parses no links", () => {
    const button = quote("writeup at https://ctf.example/pwn-300?stage=2");

    expect(button.textContent).toContain("writeup at https://ctf.example/pwn-300?stage=2");
  });

  it("pulls a fenced paste onto the one line the quote gets", () => {
    const button = quote("here:\n```py\nheap.free(i)\nheap.free(i)\n```");

    expect(button.textContent).toContain("here: heap.free(i) heap.free(i)");
  });

  it("says a message it cannot show is answered, without naming it by its id", () => {
    render(<ReplyQuote msgid="older-msgid" parent={undefined} onJump={vi.fn()} />);

    expect(screen.getByText("in reply to an earlier message")).toBeTruthy();
    expect(screen.queryByText(/older-msgid/)).toBe(null);
  });
});
