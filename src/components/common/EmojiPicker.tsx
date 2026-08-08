import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { REACTION_EMOJIS } from "@/lib/emojis";
import {
  EMOJI_CATEGORY_ICON,
  EMOJI_CATEGORY_LABELS,
  EMOJI_CATEGORY_ORDER,
  allEmojis,
  emojisInCategory,
  searchEmojis,
  type EmojiEntry,
} from "@/lib/emojiCatalog";
import { loadFavorites, loadRecents, recordRecent, toggleFavorite } from "@/lib/emojiPrefs";

type Tab = "recent" | "favorites" | (typeof EMOJI_CATEGORY_ORDER)[number];

interface Props {
  onPick: (emoji: string) => void;
  /** One row of reaction glyphs rather than the full composer grid. */
  compact?: boolean;
  className?: string;
}

const CELL =
  "group relative rounded-[var(--radius-sm)] px-1.5 py-1 text-[18px] leading-none hover:bg-[var(--surface-hover)]";

function entriesForNatives(natives: readonly string[]): EmojiEntry[] {
  const known = new Map(allEmojis().map((entry) => [entry.native, entry]));
  return natives.flatMap((native) => {
    const entry = known.get(native);
    return entry ? [entry] : [];
  });
}

function EmojiGrid({
  entries,
  favorites,
  onPick,
  onToggleFavorite,
  empty,
}: {
  entries: readonly EmojiEntry[];
  favorites: ReadonlySet<string>;
  onPick: (native: string) => void;
  onToggleFavorite: (native: string) => void;
  empty: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-[12px]" style={{ color: "var(--text-faint)" }}>
        {empty}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-8 gap-0.5 p-1">
      {entries.map((entry) => {
        const favorite = favorites.has(entry.native);
        return (
          <div key={`${entry.id}-${entry.native}`} className="group relative">
            <button
              type="button"
              title={entry.name}
              aria-label={entry.name}
              onClick={() => onPick(entry.native)}
              className={clsx(CELL, "w-full")}
            >
              {entry.native}
            </button>
            <button
              type="button"
              aria-label={
                favorite ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`
              }
              aria-pressed={favorite}
              onClick={() => onToggleFavorite(entry.native)}
              className={clsx(
                "absolute top-0 right-0 rounded-bl-[var(--radius-sm)] px-0.5 text-[9px] leading-none",
                favorite
                  ? "text-[var(--accent)] opacity-100"
                  : "text-[var(--text-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--accent)]",
              )}
            >
              {favorite ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Full Unicode emoji picker with search, recents, favorites, and every
 * category Emoji Mart ships. Compact mode keeps the short reaction strip.
 */
export function EmojiPicker({ onPick, compact = false, className }: Props) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>(() => (loadRecents().length > 0 ? "recent" : "people"));
  const [recents, setRecents] = useState(loadRecents);
  const [favorites, setFavorites] = useState(loadFavorites);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const pick = (native: string) => {
    setRecents(recordRecent(native));
    onPick(native);
  };

  const onToggleFavorite = (native: string) => {
    setFavorites(toggleFavorite(native));
  };

  const trimmed = query.trim();
  const searching = trimmed !== "";
  const searchResults = useMemo(
    () => (searching ? searchEmojis(trimmed) : []),
    [searching, trimmed],
  );

  if (compact) {
    return (
      <span
        role="group"
        aria-label="React with"
        className={clsx("flex w-max flex-wrap gap-0.5", className)}
      >
        {REACTION_EMOJIS.map((emoji, index) => (
          <button
            key={emoji}
            type="button"
            autoFocus={index === 0}
            onClick={() => pick(emoji)}
            className={CELL}
          >
            {emoji}
          </button>
        ))}
      </span>
    );
  }

  const visible = searching
    ? searchResults
    : tab === "recent"
      ? entriesForNatives(recents)
      : tab === "favorites"
        ? entriesForNatives(favorites)
        : emojisInCategory(tab);

  const empty = searching
    ? "No emoji matched that search."
    : tab === "recent"
      ? "Emoji you use will show up here."
      : tab === "favorites"
        ? "Star an emoji to save it here."
        : "Nothing in this category.";

  return (
    <div
      className={clsx(
        "flex w-72 flex-col overflow-hidden rounded-[var(--radius-md)]",
        className,
      )}
    >
      <div className="border-b border-[var(--border-subtle)] p-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all emoji…"
          aria-label="Search emoji"
          autoFocus
          className="selectable w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-base)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
        />
      </div>

      {!searching && (
        <div
          role="tablist"
          aria-label="Emoji categories"
          className="flex gap-0.5 overflow-x-auto border-b border-[var(--border-subtle)] px-1 py-1"
        >
          <TabButton active={tab === "recent"} label="Recent" onClick={() => setTab("recent")}>
            🕘
          </TabButton>
          <TabButton
            active={tab === "favorites"}
            label="Favorites"
            onClick={() => setTab("favorites")}
          >
            ⭐
          </TabButton>
          {EMOJI_CATEGORY_ORDER.map((categoryId) => (
            <TabButton
              key={categoryId}
              active={tab === categoryId}
              label={EMOJI_CATEGORY_LABELS[categoryId] ?? categoryId}
              onClick={() => setTab(categoryId)}
            >
              {EMOJI_CATEGORY_ICON[categoryId]}
            </TabButton>
          ))}
        </div>
      )}

      <div
        role="tabpanel"
        aria-label={searching ? "Search results" : EMOJI_CATEGORY_LABELS[tab] ?? tab}
        className="max-h-56 overflow-y-auto"
      >
        <EmojiGrid
          entries={visible}
          favorites={favoriteSet}
          onPick={pick}
          onToggleFavorite={onToggleFavorite}
          empty={empty}
        />
      </div>

      {!searching && tab !== "recent" && tab !== "favorites" && (
        <div
          className="border-t border-[var(--border-subtle)] px-2 py-1 text-[10px]"
          style={{ color: "var(--text-faint)" }}
        >
          {visible.length} emoji · hover ☆ to favorite
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        "shrink-0 rounded-[var(--radius-sm)] px-1.5 py-1 text-[16px] leading-none",
        active
          ? "bg-[var(--surface-active)]"
          : "hover:bg-[var(--surface-hover)]",
      )}
    >
      {children}
    </button>
  );
}
