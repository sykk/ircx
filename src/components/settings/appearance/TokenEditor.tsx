import { useState, type ReactNode } from "react";
import {
  Group,
  Note,
  SecondaryButton,
  SelectField,
  TextField,
} from "@/components/onboarding/fields";
import {
  AA_BODY,
  contrast,
  COOL_MAX,
  COOL_MIN,
  hue,
  selectOverrides,
  SURFACES,
  toHex,
  TOKEN_CATALOGUE,
  TOKEN_GROUPS,
  tokenProblem,
  type Theme,
  type TokenSpec,
} from "@/lib/theme";
import { useAppStore } from "@/store";

/**
 * One theme, token by token, with the value this person gave it.
 *
 * Every edit commits the moment it is made — there is no Apply button and no
 * draft held here — and that is a correctness requirement rather than a taste
 * for immediacy. `palette.toggle` is unconditional (src/hooks/useHotkeys.ts),
 * so Ctrl+K works with this sheet open: the command palette mounts, previews
 * themes as the selection moves, and its cleanup calls `applyTheme` on the way
 * out. Anything this component had painted out of its own state would be wiped
 * by that repaint and never come back. Routing every edit through the store and
 * src/lib/theme/apply.ts instead makes the palette's cleanup an idempotent
 * repaint of the same values.
 */
export function TokenEditor({ theme, onBack }: { theme: Theme; onBack: () => void }) {
  const overrides = useAppStore((s) => s.overrides);

  /* The one thing held locally, and it is not a value: a refused value is never
   * committed, so there is nowhere else for its sentence to live. One at a
   * time, because one field is being typed in at a time. */
  const [refused, setRefused] = useState<{ token: string; problem: string } | null>(null);

  const edits = overrides[theme.id] ?? {};
  /* What the window is actually painting for this theme, which is what the
   * warnings have to be argued against: a nick is checked against the surfaces
   * as they now are, not as the theme's author left them. */
  const merged = { ...theme.tokens, ...edits };
  const changed = Object.keys(edits).length;

  /* The gates in src/lib/theme/overrides.ts run when the record is read back at
   * the next launch, which is too late for a value typed now: `applyOverrides`
   * paints whatever it is handed, and a `url()` painted onto `--mention-bg`
   * fetches the moment a mention is drawn. So the same check runs here, before
   * the value goes anywhere. A refused value is not kept — the field snaps back
   * to what it held — because keeping it would mean a second place a value can
   * live, and this component deliberately has none. */
  function change(token: string, value: string) {
    const problem = tokenProblem(token, value);
    if (problem !== null) {
      setRefused({ token, problem });
      return;
    }
    setRefused(null);
    selectOverrides({ ...overrides, [theme.id]: { ...edits, [token]: value } });
  }

  /* Deleting the key, never writing "". `setProperty` with an empty string
   * removes the custom property, which uncovers the built-in dark theme that
   * src/styles/global.css imports statically — on ircx-light that paints a dark
   * value onto a light surface. Absent from the record is what "as the author
   * set it" means. */
  function reset(token: string) {
    const rest = { ...edits };
    delete rest[token];
    setRefused(null);
    selectOverrides({ ...overrides, [theme.id]: rest });
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[15px] font-medium text-[var(--text-primary)]">
            {theme.manifest.name}
          </h2>
          <p className="text-[12px] text-[var(--text-secondary)]">
            {changed === 0
              ? "Every token as the theme's author set it."
              : `${changed} of the author's ${Object.keys(theme.tokens).length} tokens changed.`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {changed > 0 && (
            <SecondaryButton
              label={`Reset every token of ${theme.manifest.name}`}
              onClick={() => {
                setRefused(null);
                selectOverrides({ ...overrides, [theme.id]: {} });
              }}
            >
              Reset all
            </SecondaryButton>
          )}
          <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        </div>
      </header>

      {TOKEN_GROUPS.map((group) => (
        <Group key={group} title={group}>
          {Object.entries(TOKEN_CATALOGUE)
            .filter(([, spec]) => spec.group === group)
            .map(([token, spec]) => (
              <Field
                key={token}
                token={token}
                spec={spec}
                value={edits[token] ?? theme.tokens[token] ?? ""}
                overridden={token in edits}
                refused={refused?.token === token ? refused.problem : null}
                warnings={warningsFor(token, edits[token] ?? theme.tokens[token] ?? "", merged)}
                onChange={(value) => change(token, value)}
                onReset={() => reset(token)}
              />
            ))}
          {group === "Timeline density" && (
            <Note>
              Compact and Read state these three themselves and win over an edit made
              here. Choose Comfortable to see one.
            </Note>
          )}
        </Group>
      ))}

      <Group title="As a theme.css">
        {/* Select and copy by hand. There is no clipboard plugin in
         * src-tauri/Cargo.toml and no capability granting one, and
         * navigator.clipboard under WebKitGTK on a custom scheme is not
         * dependable enough to hang a button on — a Copy button that silently
         * writes nothing is worse than no button. The window is
         * `user-select: none`, so the textarea carries `.selectable`
         * (src/styles/global.css) to be selectable at all. */}
        <Note>
          Every token, with the edits above merged in. Select it and copy it into a
          theme.css of your own.
        </Note>
        <textarea
          readOnly
          rows={12}
          spellCheck={false}
          aria-label={`${theme.manifest.name} as a theme.css`}
          value={themeCss(merged)}
          className="selectable w-full resize-y rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-base)] px-2.5 py-1.5 font-mono text-[12px] leading-6 text-[var(--text-primary)] outline-none"
        />
      </Group>
    </div>
  );
}

function Field({
  token,
  spec,
  value,
  overridden,
  refused,
  warnings,
  onChange,
  onReset,
}: {
  token: string;
  spec: TokenSpec;
  value: string;
  overridden: boolean;
  refused: string | null;
  warnings: readonly string[];
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  /* A refusal is the field's own error and takes the field's error styling;
   * warnings sit under it in the warning colour, because the value they are
   * about is applied and the window already shows what it did. */
  const note: ReactNode =
    warnings.length === 0 ? undefined : (
      <span className="text-[var(--warning)]">
        {warnings.map((warning) => (
          <span key={warning} className="block">
            {warning}
          </span>
        ))}
      </span>
    );

  return (
    <div className="flex items-end gap-2">
      {spec.kind === "color" && (
        /* `<input type="color">` holds six digits and nothing else, so an
         * eight-digit hex shows here without its alpha and anything the picker
         * cannot represent — `rgb(31 35 40 / 0.42)`, or a hex halfway through
         * being typed — falls back to the control's own black. Dropping the
         * swatch for those instead would move the field sideways under the
         * cursor on every keystroke. The text field beside it is the value of
         * record. */
        <input
          type="color"
          aria-label={`Pick ${token}`}
          value={toHex(value) ?? "#000000"}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-base)]"
        />
      )}
      <div className="min-w-0 flex-1">
        {spec.kind === "keyword" ? (
          <SelectField
            label={token}
            value={value}
            options={(spec.options ?? []).map((option) => ({ value: option, label: option }))}
            onChange={onChange}
            hint={note}
          />
        ) : (
          <TextField
            label={token}
            value={value}
            onChange={onChange}
            error={refused}
            hint={note}
          />
        )}
      </div>
      {overridden && (
        <SecondaryButton label={`Reset ${token}`} onClick={onReset}>
          Reset
        </SecondaryButton>
      )}
    </div>
  );
}

/** The colours a nickname must stay clear of, because each one already means
 * something: three connection states and the three status colours. */
const RESERVED = [
  "--state-connected",
  "--state-connecting",
  "--state-error",
  "--danger",
  "--success",
  "--warning",
];

/** A length or a bare ratio, as src/styles/tokens.test.ts requires of every
 * `--timeline-` token. */
const MEASURE = /^\d+(\.\d+)?(px|rem|em|ch)?$/;

/**
 * What is wrong with a value, said rather than enforced.
 *
 * These are the four rules src/styles/tokens.test.ts fails the build over, and
 * a theme that ships has to pass all of them. An edit made here is one person's
 * palette on one machine, and the client is not the arbiter of what they can
 * read: the value applies and the sentence appears beside it. What is refused
 * instead of warned about is the one thing that is not a matter of taste, a
 * value that fetches — that check is `tokenProblem`, above.
 *
 * Anything `toHex` cannot read comes back with nothing said. Every function in
 * src/lib/theme/contrast.ts assumes six digits, and a comparison against NaN is
 * silently false, so a half-typed hex would otherwise stop the warnings rather
 * than pass them.
 */
function warningsFor(
  token: string,
  value: string,
  merged: Record<string, string>,
): string[] {
  if (token.startsWith("--timeline-")) {
    return MEASURE.test(value.trim())
      ? []
      : [
          "Not a measure. A length like 12px or a bare ratio like 1.55 — anything else collapses the column instead of restyling it.",
        ];
  }
  if (!token.startsWith("--nick-")) return [];

  const nick = toHex(value);
  if (nick === null) return [];

  const found: string[] = [];

  for (const surface of SURFACES) {
    const behind = toHex(merged[`--${surface}`] ?? "");
    if (behind === null) continue;
    const ratio = contrast(nick, behind);
    if (ratio < AA_BODY) {
      found.push(
        `Reads at ${ratio.toFixed(1)}:1 on --${surface}. A nickname is body text and wants ${AA_BODY}:1.`,
      );
    }
  }

  const nickHue = hue(nick);
  if (nickHue < COOL_MIN || nickHue > COOL_MAX) {
    found.push(
      `Hue ${Math.round(nickHue)}° is outside the ${COOL_MIN}–${COOL_MAX}° band the nick palette keeps to, which is what holds it clear of the colours that mean something.`,
    );
  }

  for (const name of RESERVED) {
    const reserved = toHex(merged[name] ?? "");
    if (reserved === null) continue;
    const apart = Math.abs(nickHue - hue(reserved));
    if (Math.min(apart, 360 - apart) <= 20) {
      found.push(
        `Within 20° of ${name}. A nickname wearing the colour that means an error is a lie the reader cannot see.`,
      );
    }
  }

  return found;
}

/** The merged tokens as a stylesheet. The order is the theme file's own, not
 * the catalogue's: merging an edit replaces a key in place, so what comes out
 * reads like the file it came from — surfaces first, measurements last —
 * rather than as an alphabetical list of everything. */
function themeCss(tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${body}\n}\n`;
}
