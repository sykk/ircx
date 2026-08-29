import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Reaction } from "@/types";
import { Tooltip } from "@/components/common/Tooltip";
import { Icon } from "@/components/common/Icon";
import { loadMostUsed, recordRecent } from "@/lib/emojiPrefs";
import { REACTION_EMOJIS } from "@/lib/emojis";

/** More names than this and the tooltip runs off the window, so the rest of
 * them stay a count. */
const NAMES_SHOWN = 12;

const EmojiPicker = lazy(() =>
  import("@/components/common/EmojiPicker").then(({ EmojiPicker }) => ({ default: EmojiPicker })),
);

const CHIP = "flex items-center rounded-[var(--radius-sm)] border px-2 py-[3px]";

/** `mb-1`/`mt-1`, as a number, because the room above has to be measured
 * against the same gap the picker is drawn with. */
const PICKER_GAP = 4;
const QUIET = "border-[var(--border-default)] bg-[var(--surface-raised)]";

function quickReactions(): string[] {
  const ranked = loadMostUsed();
  return [...ranked, ...REACTION_EMOJIS.filter((emoji) => !ranked.includes(emoji))].slice(0, 3);
}

interface Props {
  reactions: readonly Reaction[];
  ownNick: string | null;
  /**
   * Null when this message cannot be reacted to: the server has no
   * `message-tags`, or nothing has named the message yet. The chips are then a
   * record of what other people sent rather than a control.
   */
  onToggle: ((emoji: string, active: boolean) => void) | null;
}

/**
 * A count on its own is a popularity metric. The names are the information and
 * arrive with the reaction, so every chip carries them.
 */
export function Reactions({ reactions, ownNick, onToggle }: Props) {
  if (reactions.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {reactions.map((reaction) => (
        <Chip
          key={reaction.emoji}
          reaction={reaction}
          ownNick={ownNick}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function Chip({
  reaction,
  ownNick,
  onToggle,
}: {
  reaction: Reaction;
  ownNick: string | null;
  onToggle: Props["onToggle"];
}) {
  const mine = ownNick !== null && reaction.nicks.includes(ownNick);
  const names = reactorNames(reaction.nicks, ownNick);

  return (
    <Tooltip label={names} placement="top">
      <button
        type="button"
        // Focusable rather than `disabled` so the names stay readable from the
        // keyboard on a server that cannot carry a reaction back.
        aria-disabled={onToggle === null || undefined}
        aria-pressed={onToggle === null ? undefined : mine}
        aria-label={`${reaction.emoji} — ${names}`}
        onClick={onToggle === null ? undefined : () => onToggle(reaction.emoji, !mine)}
        className={clsx(
          CHIP,
          "gap-1.5",
          mine ? "border-[var(--accent)] bg-[var(--accent-muted)]" : QUIET,
          onToggle !== null && !mine && "hover:bg-[var(--surface-hover)]",
        )}
      >
        <span aria-hidden="true" className="text-[14px] leading-none">
          {reaction.emoji}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[11px] leading-none tabular-nums"
          style={{ color: "var(--text-secondary)" }}
        >
          {reaction.nicks.length}
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The controls that answer a message: reply to it, react to it, or both.
 *
 * The mockup draws no control at rest, so the pair appears with the pointer,
 * and with focus landing anywhere in the row — which makes a link or a reply
 * quote a route to it.
 *
 * They used to be laid over the far end of the measure to avoid taking room.
 * A long line then ran underneath them and could not be clicked, so they have
 * a column of their own and the room is reserved whether or not they are drawn.
 */
export function RowControls({
  alone,
  onReply,
  onPick,
  onBookmark,
  bookmarked,
}: {
  alone: boolean;
  onReply: (() => void) | null;
  onPick: ((emoji: string) => void) | null;
  onBookmark: (() => void) | null;
  bookmarked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(true);
  const [mostUsed, setMostUsed] = useState(quickReactions);
  const anchor = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLSpanElement>(null);

  // The picker opens upward, over rows that painted before it. On a row near
  // the top of the scroller there is nothing above to open into and it went out
  // over the channel header instead — the one place in this app anything is
  // drawn over it. The timeline's own top is the ceiling: a pane's, so a split
  // measures its own. Read in a layout effect, which runs after it is laid out
  // and before it is painted, so the flip is not a flicker somebody sees.
  useLayoutEffect(() => {
    if (!open) return;
    const button = anchor.current;
    const panel = picker.current;
    if (!button || !panel) return;
    const ceiling = button.closest("[data-ui='timeline']")?.getBoundingClientRect().top ?? 0;
    setAbove(button.getBoundingClientRect().top - ceiling >= panel.offsetHeight + PICKER_GAP);
  }, [open]);

  return (
    <span
      className={clsx(
        // `alone` is the pair in their own column, which appears with the
        // pointer. The chips' own `+` sits among them and is always drawn.
        alone && !open && "hidden group-focus-within:block group-hover:block",
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        anchor.current?.focus();
      }}
      // Tabbing or clicking away closes it. Leaving it open behind a pane the
      // user has moved on from is a popover they have to come back to dismiss.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="relative inline-flex gap-0.5">
        {onPick !== null &&
          mostUsed.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                onPick(emoji);
                recordRecent(emoji);
                setMostUsed(quickReactions());
              }}
              className={clsx(CHIP, QUIET, "hover:bg-[var(--surface-hover)]")}
            >
              <span aria-hidden="true" className="text-[14px] leading-none">
                {emoji}
              </span>
            </button>
          ))}
        {onBookmark !== null && (
          <button type="button" aria-label={bookmarked ? "Remove bookmark" : "Bookmark this message"} aria-pressed={bookmarked} onClick={onBookmark} className={clsx(CHIP, QUIET, "hover:bg-[var(--surface-hover)]")} style={{ color: bookmarked ? "var(--accent)" : "var(--text-muted)" }}>
            <Icon name="pin" size={14} />
          </button>
        )}
        {onReply !== null && (
          <button
            type="button"
            aria-label="Reply to this message"
            onClick={onReply}
            className={clsx(CHIP, QUIET, "hover:bg-[var(--surface-hover)]")}
            style={{ color: "var(--text-muted)" }}
          >
            <span
              aria-hidden="true"
              className="font-[family-name:var(--font-mono)] text-[14px] leading-none"
            >
              ↩
            </span>
          </button>
        )}
        {onPick !== null && (
          <>
            <button
              ref={anchor}
              type="button"
              aria-expanded={open}
              aria-label="Add a reaction"
              onClick={() => setOpen((was) => !was)}
              className={clsx(CHIP, QUIET, "hover:bg-[var(--surface-hover)]")}
              style={{ color: "var(--text-muted)" }}
            >
              <span
                aria-hidden="true"
                className="font-[family-name:var(--font-mono)] text-[14px] leading-none"
              >
                +
              </span>
            </button>

            {open && (
              <span
                ref={picker}
                className={clsx(
                  // The unloaded shell stays as tall as the compact picker, so
                  // the position calculation above does not measure an empty chunk.
                  "absolute right-0 z-10 min-h-[36px] rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]",
                  above ? "bottom-full mb-1" : "top-full mt-1",
                )}
              >
                <Suspense fallback={null}>
                  <EmojiPicker
                    ariaLabel="React with"
                    onPick={(emoji) => {
                      onPick(emoji);
                      setOpen(false);
                      anchor.current?.focus();
                    }}
                  />
                </Suspense>
              </span>
            )}
          </>
        )}
      </span>
    </span>
  );
}

/** Arrival order, which is the order the protocol delivered them in. Your own
 * nick is written as `you`, so whether you are already in the list is legible
 * without matching your own name against it. */
function reactorNames(nicks: readonly string[], ownNick: string | null): string {
  const shown = nicks
    .slice(0, NAMES_SHOWN)
    .map((nick) => (nick === ownNick ? "you" : nick))
    .join(", ");
  const rest = nicks.length - NAMES_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
