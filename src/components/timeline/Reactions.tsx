import { useRef, useState } from "react";
import clsx from "clsx";
import type { Reaction } from "@/types";
import { Tooltip } from "@/components/common/Tooltip";

/**
 * What the picker offers. A short list on purpose: the `+draft/react` value is
 * free text on the wire, so `/react <msgid> <value>` reaches anything not here,
 * and a grid of a thousand glyphs is chrome the mockup does not draw.
 */
const OFFERED = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀", "🔥", "✅"];

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
  if (reactions.length === 0) {
    if (onToggle === null) return null;
    return <AddReaction alone onPick={(emoji) => onToggle(emoji, true)} />;
  }

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
      {onToggle !== null && (
        <AddReaction alone={false} onPick={(emoji) => onToggle(emoji, true)} />
      )}
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
 * `alone` is a message nobody has reacted to yet. The mockup draws no control
 * there, so it appears with the pointer, and with focus landing anywhere in the
 * row — which makes a link or a reply quote a route to it.
 *
 * Positioned over the empty end of the measure rather than under the text: a
 * control that took up room would move every message below the one being
 * pointed at, and sweeping down the timeline would make it jump.
 */
function AddReaction({ alone, onPick }: { alone: boolean; onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <span
      className={clsx(
        alone && "absolute top-0 right-0",
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
      <span className="relative inline-flex">
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
            role="group"
            aria-label="React with"
            className="absolute bottom-full left-0 z-10 mb-1 flex w-max gap-0.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-overlay)]"
          >
            {OFFERED.map((emoji, index) => (
              <button
                key={emoji}
                type="button"
                // The picker opens under the keyboard as well as the pointer,
                // so the first choice takes focus and Tab walks the rest.
                autoFocus={index === 0}
                onClick={() => {
                  onPick(emoji);
                  setOpen(false);
                  anchor.current?.focus();
                }}
                className="rounded-[var(--radius-sm)] px-1.5 py-1 text-[15px] leading-none hover:bg-[var(--surface-hover)]"
              >
                {emoji}
              </button>
            ))}
          </span>
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
