import type { CSSProperties } from "react";
import clsx from "clsx";
import { Icon } from "@/components/common/Icon";
import { nickColor } from "@/lib/nickColor";
import { selectTheme, type Overrides, type Theme } from "@/lib/theme";

/** The six tokens a card shows as chips: the ground a theme is built on, then
 * the three colours it says things with. Enough to tell two dark themes apart
 * at a glance, which is what the row is for. */
const CHIPS: readonly string[] = [
  "--surface-base",
  "--surface-raised",
  "--border-strong",
  "--accent",
  "--success",
  "--danger",
];

/** The nicks in the sample. Two, because one colour proves nothing about a
 * palette and the pair is what the reader will be telling apart. */
const SAMPLE_NICKS = ["alex", "mira"] as const;

/**
 * Every theme that loaded, each drawn in its own colours.
 *
 * The sample inside a card is painted by putting that theme's tokens on the
 * card as inline custom properties, so the sample resolves them and the card's
 * own chrome — the border, the name, the Edit button — keeps resolving the
 * theme in force. Nothing is copied out of a theme by hand, which is what
 * stops this row disagreeing with what selecting it would actually do.
 *
 * The reader's edits are merged over the author's values, so a card shows the
 * theme as this person has it rather than as it shipped.
 */
export function ThemeCards({
  themes,
  themeId,
  overrides,
  onEdit,
}: {
  themes: readonly Theme[];
  themeId: string;
  overrides: Overrides;
  onEdit: (theme: string) => void;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
      {themes.map((theme) => {
        const chosen = theme.id === themeId;
        const tokens = { ...theme.tokens, ...overrides[theme.id] } as CSSProperties;
        return (
          <li key={theme.id}>
            <div
              className={clsx(
                "relative flex flex-col gap-2 rounded-[var(--radius-lg)] border p-3",
                chosen
                  ? "border-[var(--accent)]"
                  : "border-[var(--border-default)] hover:border-[var(--border-strong)]",
              )}
            >
              {chosen && (
                <span
                  aria-hidden
                  className="absolute top-2 right-2 grid h-4 w-4 place-items-center rounded-full bg-[var(--accent)] text-[var(--text-inverse)]"
                >
                  <Icon name="check" size={10} />
                </span>
              )}

              <button
                type="button"
                aria-pressed={chosen}
                onClick={() => selectTheme(theme.id)}
                className="flex flex-col items-stretch gap-2 text-left"
              >
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {theme.manifest.name}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {theme.manifest.appearance}
                    {chosen && " · in use"}
                  </span>
                </span>

                <span
                  style={tokens}
                  className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-base)] p-2"
                >
                  {SAMPLE_NICKS.map((nick) => (
                    <span key={nick} className="flex gap-1.5 text-[11px]">
                      <span
                        className="font-[family-name:var(--font-mono)]"
                        style={{ color: nickColor(nick) }}
                      >
                        &lt;{nick}&gt;
                      </span>
                      <span style={{ color: "var(--text-primary)" }}>message</span>
                    </span>
                  ))}
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    * system message
                  </span>

                  <span className="flex gap-1 pt-0.5">
                    {CHIPS.map((token) => (
                      <span
                        key={token}
                        className="h-3.5 w-3.5 rounded-[3px] border border-[var(--border-subtle)]"
                        style={{ background: `var(${token})` }}
                      />
                    ))}
                  </span>
                </span>
              </button>

              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[11px] text-[var(--text-faint)]">
                  {theme.manifest.author} · {theme.manifest.version}
                </span>
                <button
                  type="button"
                  aria-label={`Edit the colours of ${theme.manifest.name}`}
                  onClick={() => onEdit(theme.id)}
                  className="shrink-0 text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  Edit
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
