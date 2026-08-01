import { useState } from "react";
import { useAppStore } from "@/store";
import { useInputHistory } from "@/store/selectors";

/**
 * Where the box sits in the lines already sent here, while it is showing one of
 * them rather than what was typed.
 */
interface Browsing {
  /** Index into the history, 0 being the line sent most recently. */
  index: number;
  /** What the box held when recall started. Walking forward past the newest
   * line puts this back, so an accidental Up costs nothing. */
  pending: string;
}

export interface Recall {
  /** The line before this one, or null at the oldest — and on the first step
   * when nothing has been sent here yet, so the key can fall through to the
   * caret rather than being eaten for nothing. */
  older: (current: string) => string | null;
  /** The line after this one, or what was being typed once past the newest.
   * Null when not recalling anything, which is the same fall-through. */
  newer: () => string | null;
  /** What the box held before recall started, or null when it holds what was
   * typed. A caller that persists the box saves this instead: a line being
   * looked at is not a draft, and must not overwrite one. */
  pending: string | null;
  /** Files a sent line under this conversation and leaves recall. */
  remember: (text: string) => void;
  /** Leaves recall, keeping whatever is in the box. For the caller to use when
   * the text is edited: from then on it is being typed, not looked at. */
  reset: () => void;
}

/**
 * Stepping back through what was already sent in one conversation.
 *
 * The line comes back into the box to be sent again — nothing amends the
 * message that was already delivered, because IRC has nothing to amend it with.
 * Fixing a typo is sending the corrected line.
 */
export function useRecall(network: string, target: string): Recall {
  const history = useInputHistory(network, target);
  const [browsing, setBrowsing] = useState<Browsing | null>(null);

  return {
    pending: browsing?.pending ?? null,

    older: (current) => {
      const index = browsing ? browsing.index + 1 : 0;
      if (index >= history.length) return null;
      setBrowsing({ index, pending: browsing?.pending ?? current });
      return history[index]!;
    },

    newer: () => {
      if (!browsing) return null;
      if (browsing.index === 0) {
        setBrowsing(null);
        return browsing.pending;
      }
      const index = browsing.index - 1;
      setBrowsing({ ...browsing, index });
      return history[index]!;
    },

    remember: (text) => {
      useAppStore.getState().rememberInput(network, target, text);
      setBrowsing(null);
    },

    reset: () => setBrowsing(null),
  };
}
