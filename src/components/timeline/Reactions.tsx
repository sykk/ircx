import { useRef, useState } from "react";
import clsx from "clsx";
import type { Reaction } from "@/types";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { Tooltip } from "@/components/common/Tooltip";
import { Icon } from "@/components/common/Icon";

/** More names than this and the tooltip runs off the window, so the rest of
 * them stay a count. */
const NAMES_SHOWN = 12;

const CHIP = "flex items-center rounded-[var(--radius-sm)] border px-2 py-[3px]";
const QUIET = "border-[var(--border-default)] bg-[var(--surface-raised)]";

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
 * `readability/READABILITY.md` study 14: a count on its own is a popularity
 * metric, and in a nine-person channel the names are the information. They
 * arrive with the reaction, so every chip carries them.
 */
export function Reactions({ reactions, ownNick, onToggle }: Props) {
  if (reactions.length === 0) return null;
  const pick = onToggle === null ? null : (emoji: string) => onToggle(emoji, true);

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
      {pick !== null && <RowControls alone={false} onReply={null} onPick={pick} onBookmark={null} bookmarked={false} />}
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
  const anchor = useRef<HTMLButtonElement>(null);

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
              <span className="absolute bottom-full left-0 z-10 mb-1 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]">
                <EmojiPicker
                  compact
                  onPick={(emoji) => {
                    onPick(emoji);
                    setOpen(false);
                    anchor.current?.focus();
                  }}
                />
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
