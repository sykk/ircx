import clsx from "clsx";
import {
  Group,
  LinkButton,
  Note,
  SelectField,
  CheckField,
} from "@/components/onboarding/fields";
import {
  CLOCK_FORMATS,
  CLOCK_SIDES,
  DENSITIES,
  MESSAGE_SIZES,
  MONO_FACES,
  PRESETS,
  PROSE_FACES,
  TIMELINE_ALIGNS,
  ZOOM_LEVELS,
  selectDensity,
  selectOverrides,
  selectPresentation,
  selectPreset,
  selectSidebarCompact,
  selectTypography,
  type ClockFormat,
  type ClockSide,
  type DensityId,
  type MessageSize,
  type Overrides,
  type Presentation,
  type Theme,
  type TimelineAlign,
  type Typography,
} from "@/lib/theme";
import { ACCENTS, accentTokens, type Accent } from "./accents";

/**
 * Everything on this page that is not a theme, in the column beside the
 * preview.
 *
 * The order is what each control costs to try. The accent and the density
 * change one thing about the sample; the timeline settings change how a
 * conversation is laid out; a preset overwrites most of the column at once,
 * so it is last, where it cannot be reached for before the settings it
 * replaces have been seen.
 */
export function AppearanceRail({
  theme,
  themeId,
  overrides,
  density,
  sidebarCompact,
  presentation,
  typography,
  onEditTokens,
}: {
  /** The theme in force, or null when the one named is not installed. */
  theme: Theme | null;
  themeId: string;
  overrides: Overrides;
  density: DensityId;
  sidebarCompact: boolean;
  presentation: Presentation;
  typography: Typography;
  onEditTokens: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <AccentRow theme={theme} themeId={themeId} overrides={overrides} onCustom={onEditTokens} />

      <Group title="Density">
        <ChoiceList
          label="Density"
          value={density}
          options={DENSITIES.map(({ id, name, detail }) => ({ id, name, detail }))}
          onChange={selectDensity}
        />
      </Group>

      <Group title="Sidebar">
        <CheckField
          label="Compact sidebar"
          hint="Fits more networks and conversations without reducing text size."
          checked={sidebarCompact}
          onChange={selectSidebarCompact}
        />
      </Group>

      <Group title="Window scale">
        <ScaleStepper zoom={typography.zoom} />
        <Note>Scales the whole window, the way a browser&rsquo;s zoom does.</Note>
      </Group>

      <Group title="Timeline">
        <SelectField<ClockFormat>
          label="Timestamp"
          value={presentation.clock}
          options={CLOCK_FORMATS.map(({ id, name, example }) => ({
            value: id,
            label: example === null ? name : `${name} · ${example}`,
          }))}
          onChange={(clock) => selectPresentation({ clock })}
        />

        {/* Offered even with the clock off, where it changes nothing: hiding it
            would move the controls under it every time somebody tried Off. */}
        <SelectField<ClockSide>
          label="Timestamp place"
          value={presentation.clockSide}
          options={CLOCK_SIDES.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(clockSide) => selectPresentation({ clockSide })}
        />

        <SelectField<TimelineAlign>
          label="Conversation position"
          value={presentation.align}
          options={TIMELINE_ALIGNS.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(align) => selectPresentation({ align })}
        />

        <CheckField
          label="Spine"
          hint="The rule at the rail. Its colour names the conversation a run belongs to, which nothing else on the row says."
          checked={presentation.spine}
          onChange={(spine) => selectPresentation({ spine })}
        />

        <CheckField
          label="Nickname on every line"
          hint="Each line states who said it and when, instead of the run stating it once above them."
          checked={presentation.nickEveryLine}
          onChange={(nickEveryLine) => selectPresentation({ nickEveryLine })}
        />

        <CheckField
          label="Compact single-message runs"
          hint="Puts the nickname and time in front of the message when a run has only one line."
          checked={presentation.compactSingletons}
          onChange={(compactSingletons) => selectPresentation({ compactSingletons })}
        />

        <CheckField
          label="Angle brackets around nicknames"
          hint="<alice> rather than alice, wherever the name is written, as clients that named every line wrote it."
          checked={presentation.nickBrackets}
          onChange={(nickBrackets) => selectPresentation({ nickBrackets })}
        />
      </Group>

      <Group title="Type">
        <SelectField<MessageSize>
          label="Message text"
          value={presentation.messageSize}
          options={MESSAGE_SIZES.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(messageSize) => selectPresentation({ messageSize })}
        />

        <SelectField
          label="Prose"
          value={typography.prose}
          options={PROSE_FACES.map((face) => ({ value: face.id, label: face.name }))}
          onChange={(prose) => selectTypography({ prose })}
        />

        <SelectField
          label="Identifiers and code"
          value={typography.mono}
          options={MONO_FACES.map((face) => ({ value: face.id, label: face.name }))}
          onChange={(mono) => selectTypography({ mono })}
        />
      </Group>

      <Group title="Start from">
        {/* Buttons rather than the radios the density above gets, and the
            difference is the point: a preset is not a mode the window is in.
            It writes the theme, the timeline and the faces and stops existing,
            each of them still the reader's afterwards — so there is nothing
            here for a mark to be true of. */}
        <ul className="flex flex-col gap-1">
          {PRESETS.map((preset) => (
            <li key={preset.id}>
              {/* Named apart from the theme of the same name, which is a card
                  on the left and is only half of what this does. */}
              <button
                type="button"
                aria-label={`Start from ${preset.name}`}
                onClick={() => selectPreset(preset)}
                className="flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]"
              >
                <span className="text-[13px] text-[var(--text-primary)]">{preset.name}</span>
                <span className="text-[11px] text-[var(--text-muted)]">{preset.detail}</span>
              </button>
            </li>
          ))}
        </ul>
        <Note>
          A preset sets the theme, the timeline and the faces together. Each of them stays yours
          to change afterwards.
        </Note>
      </Group>
    </div>
  );
}

/**
 * The accent, as seven values and a way out to all of them.
 *
 * Written as an override on the theme in force rather than as a setting of its
 * own, because that is what an accent is: one of the theme's tokens, and the
 * record is keyed by theme so a blue chosen against dark surfaces does not
 * follow the reader onto the light ones.
 */
function AccentRow({
  theme,
  themeId,
  overrides,
  onCustom,
}: {
  theme: Theme | null;
  themeId: string;
  overrides: Overrides;
  onCustom: () => void;
}) {
  const inForce = (overrides[themeId]?.["--accent"] ?? theme?.tokens["--accent"] ?? "").toLowerCase();

  function choose(accent: Accent) {
    selectOverrides({
      ...overrides,
      [themeId]: {
        ...overrides[themeId],
        ...accentTokens(accent, theme?.manifest.appearance ?? "dark"),
      },
    });
  }

  return (
    <Group title="Accent">
      <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-1.5">
        {ACCENTS.map((accent) => {
          const chosen = accent.base.toLowerCase() === inForce;
          return (
            <button
              key={accent.base}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={accent.name}
              title={accent.name}
              onClick={() => choose(accent)}
              style={{ background: accent.base }}
              /* One ring, drawn outside the swatch. Inside it would eat the
                 colour the swatch exists to show, and a second ring in the
                 accent would be the chosen colour marking itself. */
              className={clsx(
                "h-6 w-6 rounded-[var(--radius-sm)] border border-[var(--border-default)]",
                chosen && "outline outline-2 outline-offset-2 outline-[var(--text-primary)]",
              )}
            />
          );
        })}
      </div>
      {/* Where the accent that is not one of the seven lives, along with every
          other token: the editor is per-theme and this is a theme's token. */}
      <LinkButton onClick={onCustom}>Custom…</LinkButton>
    </Group>
  );
}

/** The window scale, stepped through `ZOOM_LEVELS`. A scale the list does not
 * hold — one left by an older build — reads as the nearest step below, so the
 * buttons still lead somewhere rather than both going dead. */
function ScaleStepper({ zoom }: { zoom: number }) {
  const at = Math.max(
    0,
    ZOOM_LEVELS.findLastIndex((level) => level <= zoom),
  );

  function step(by: number) {
    const next = ZOOM_LEVELS[at + by];
    if (next !== undefined) selectTypography({ zoom: next });
  }

  return (
    <div className="flex items-center gap-1">
      <StepButton label="Smaller" disabled={at === 0} onClick={() => step(-1)}>
        &minus;
      </StepButton>
      {/* `output` rather than a span: it is a value the two buttons compute,
          and a screen reader is told so when it changes. */}
      <output className="min-w-[4rem] text-center text-[13px] text-[var(--text-primary)]">
        {Math.round((ZOOM_LEVELS[at] ?? 1) * 100)}%
      </output>
      <StepButton
        label="Larger"
        disabled={at === ZOOM_LEVELS.length - 1}
        onClick={() => step(1)}
      >
        +
      </StepButton>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 rounded-[var(--radius-sm)] border border-[var(--border-default)] text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-[var(--disabled-opacity)]"
    >
      {children}
    </button>
  );
}

/** One of a few named choices, each with a line saying who it is for. A
 * radiogroup because that is what it is: the options are exclusive and the
 * chosen one is a state the window is in — which is exactly what is not true
 * of the presets at the foot of the rail. */
function ChoiceList<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; name: string; detail: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
      {options.map((option) => {
        const chosen = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            onClick={() => onChange(option.id)}
            className="flex items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]"
          >
            <span
              aria-hidden
              className={clsx(
                "mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border",
                chosen ? "border-[var(--accent)]" : "border-[var(--border-strong)]",
              )}
            >
              {chosen && <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] text-[var(--text-primary)]">{option.name}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{option.detail}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
