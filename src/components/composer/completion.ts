export interface Completion {
  /** Range in the source text the candidate replaces. */
  start: number;
  end: number;
  candidates: string[];
  index: number;
  /** Text and caret after the current candidate is applied. */
  text: string;
  caret: number;
}

const WORD_BREAK = /[\s,]/;

function wordStart(text: string, caret: number): number {
  let at = caret;
  while (at > 0 && !WORD_BREAK.test(text[at - 1]!)) at--;
  return at;
}

function suffix(atLineStart: boolean): string {
  return atLineStart ? ": " : " ";
}

function isLineStart(text: string, start: number): boolean {
  return start === 0 || text[start - 1] === "\n";
}

function render(
  text: string,
  start: number,
  end: number,
  candidates: string[],
  index: number,
): Completion {
  const replacement = candidates[index]! + suffix(isLineStart(text, start));
  return {
    start,
    end,
    candidates,
    index,
    text: text.slice(0, start) + replacement + text.slice(end),
    caret: start + replacement.length,
  };
}

/**
 * First Tab press. Returns null when the word under the caret matches nothing,
 * so the key can fall through rather than eat the user's Tab silently.
 */
export function startCompletion(
  text: string,
  caret: number,
  candidates: readonly string[],
): Completion | null {
  const start = wordStart(text, caret);
  const prefix = text.slice(start, caret);
  if (prefix === "") return null;

  const matches = candidates.filter((c) => c.toLowerCase().startsWith(prefix.toLowerCase()));
  if (matches.length === 0) return null;

  return render(text, start, caret, matches, 0);
}

/**
 * Later Tab presses swap in the next candidate. The range to replace runs to
 * the previous caret, which sits after the separator the last render added.
 */
export function cycleCompletion(previous: Completion): Completion {
  const index = (previous.index + 1) % previous.candidates.length;
  return render(
    previous.text,
    previous.start,
    previous.caret,
    previous.candidates,
    index,
  );
}
