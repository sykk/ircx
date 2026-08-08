import type { EmojiMartData } from "@emoji-mart/data";
import emojiData from "@emoji-mart/data/sets/15/native.json";
import { NO_MATCH, prepare, scoreMatch, type Haystack } from "./fuzzy";

const data = emojiData as EmojiMartData;

export const EMOJI_CATEGORY_ORDER = data.categories.map((category) => category.id);

export const EMOJI_CATEGORY_LABELS: Record<string, string> = {
  people: "Smileys & people",
  nature: "Animals & nature",
  foods: "Food & drink",
  activity: "Activities",
  places: "Travel & places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

export const EMOJI_CATEGORY_ICON: Record<string, string> = {
  people: "😀",
  nature: "🐻",
  foods: "🍎",
  activity: "⚽",
  places: "🚗",
  objects: "💡",
  symbols: "❤️",
  flags: "🏁",
};

export interface EmojiEntry {
  id: string;
  native: string;
  name: string;
  category: string;
  prepared: Haystack;
}

let catalog: EmojiEntry[] | null = null;
let byCategory: Map<string, EmojiEntry[]> | null = null;

function buildCatalog(): void {
  catalog = [];
  byCategory = new Map();

  for (const category of data.categories) {
    const group: EmojiEntry[] = [];
    for (const id of category.emojis) {
      const emoji = data.emojis[id];
      if (!emoji) continue;
      const native = emoji.skins[0]?.native;
      if (!native) continue;
      const entry: EmojiEntry = {
        id: emoji.id,
        native,
        name: emoji.name,
        category: category.id,
        prepared: prepare(`${emoji.name} ${emoji.keywords.join(" ")}`),
      };
      catalog.push(entry);
      group.push(entry);
    }
    byCategory.set(category.id, group);
  }
}

/** Every emoji Emoji Mart ships for Unicode 15. Built once on first use. */
export function allEmojis(): readonly EmojiEntry[] {
  if (!catalog) buildCatalog();
  return catalog!;
}

export function emojisInCategory(categoryId: string): readonly EmojiEntry[] {
  if (!byCategory) buildCatalog();
  return byCategory!.get(categoryId) ?? [];
}

/** Ranked by the same fuzzy matcher the command palette uses. */
export function searchEmojis(query: string, limit = 100): EmojiEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return [];

  return allEmojis()
    .map((entry) => ({ entry, score: scoreMatch(trimmed, entry.prepared) }))
    .filter((row) => row.score > NO_MATCH)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((row) => row.entry);
}

/** Resolve a native character back to its catalog row, if known. */
export function emojiEntry(native: string): EmojiEntry | undefined {
  return allEmojis().find((entry) => entry.native === native);
}
