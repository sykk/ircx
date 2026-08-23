import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/types";

/** The newest message array made available to timeline derivation this frame. */
export function useFrameMessages(messages: ChatMessage[]): ChatMessage[] {
  const [drawn, setDrawn] = useState(messages);
  const latest = useRef(messages);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    latest.current = messages;
    if (messages === drawn || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setDrawn(latest.current);
    });
  }, [messages, drawn]);

  useLayoutEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return drawn;
}
