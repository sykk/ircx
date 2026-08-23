import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import { makeMessage } from "./fixtures";
import { useFrameMessages } from "./frameMessages";

let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  frames = new Map();
  let nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("presents only the latest message array once per frame", () => {
  const first = [makeMessage({ id: "a" })];
  const second = [...first, makeMessage({ id: "b" })];
  const third = [...second, makeMessage({ id: "c" })];
  const { result, rerender } = renderHook(
    ({ messages }: { messages: ChatMessage[] }) => useFrameMessages(messages),
    { initialProps: { messages: first } },
  );

  rerender({ messages: second });
  rerender({ messages: third });

  expect(result.current).toBe(first);
  expect(frames.size).toBe(1);

  act(() => {
    for (const frame of frames.values()) frame(16);
    frames.clear();
  });

  expect(result.current).toBe(third);
  expect(frames.size).toBe(0);
});
