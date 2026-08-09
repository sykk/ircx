import { useState } from "react";
import {
  CheckField,
  Group,
  Note,
  SecondaryButton,
  SelectField,
} from "@/components/onboarding/fields";
import { chooseFolder, ipc, revealFolder } from "@/lib/ipc";
import {
  CLOCK_FORMATS,
  DENSITIES,
  MONO_FACES,
  PRESETS,
  PROSE_FACES,
  ZOOM_LEVELS,
  selectDensity,
  selectPresentation,
  selectPreset,
  selectTheme,
  selectTypography,
  type BrokenTheme,
  type ClockFormat,
  type DensityId,
  type Presentation,
  type Theme,
  type Typography,
} from "@/lib/theme";

/**
 * The themes that loaded, the densities, what the timeline draws, and the
 * themes that did not load.
 *
 * The failures are the reason this screen is worth a sheet of its own. Until
 * now a directory that would not load reached the person holding the file as a
 * console warning (src/lib/theme/session.ts) and a single line in the palette,
 * with every sentence but the first cut off. They are written to be acted on —
 * each one names the field or the property that is wrong and what belongs in
 * it — so here they are listed whole.
 */
export function ThemeList({
  themes,
  broken,
  themeId,
  density,
  presentation,
  typography,
  onClose,
  onEdit,
}: {
  themes: readonly Theme[];
  broken: readonly BrokenTheme[];
  themeId: string;
  density: DensityId;
  presentation: Presentation;
  typography: Typography;
  onClose: () => void;
  onEdit: (theme: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-4">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)]">Appearance</h2>
        {/* Escape closes the sheet, but only for someone who knows to try it. */}
        <SecondaryButton label="Close appearance" onClick={onClose}>
          Done
        </SecondaryButton>
      </header>

      <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
        {themes.map((theme) => (
          <li key={theme.id} className="flex items-center justify-between gap-4 py-3">
            {/* Which one is in use is otherwise only in the line under the
                name, where a reader has to reach the end of the sentence for
                it and a screen reader is told nothing at all. */}
            <button
              type="button"
              aria-pressed={theme.id === themeId}
              onClick={() => selectTheme(theme.id)}
              className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
            >
              <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
                {theme.manifest.name}
              </h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                {describeTheme(theme, theme.id === themeId)}
              </p>
            </button>
            <SecondaryButton
              label={`Edit the colours of ${theme.manifest.name}`}
              onClick={() => onEdit(theme.id)}
            >
              Edit
            </SecondaryButton>
          </li>
        ))}
      </ul>

      <Group title="Density">
        <ul className="flex flex-col gap-1">
          {DENSITIES.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={option.id === density}
                onClick={() => selectDensity(option.id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]"
              >
                <span className="text-[13px] text-[var(--text-primary)]">
                  {option.name}
                  {option.id === density && (
                    <span className="text-[var(--text-muted)]"> · in use</span>
                  )}
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">{option.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      </Group>

      <InstallTheme />

      <Group title="Start from">
        <ul className="flex flex-col gap-1">
          {PRESETS.map((preset) => (
            <li key={preset.id}>
              {/* Named apart from the theme of the same name, which is the
                  next control down and is only half of what this does. */}
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
        {/* Nothing here is marked as in use: a preset writes the settings below
            and stops existing, and a mark would claim the window is in a mode
            that can be left. */}
        <Note>
          A preset sets the theme, the timeline and the faces together. Each of them stays yours
          to change afterwards.
        </Note>
      </Group>

      <Group title="Type">
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

        <SelectField
          label="Window scale"
          value={String(typography.zoom)}
          options={ZOOM_LEVELS.map((level) => ({
            value: String(level),
            label: `${Math.round(level * 100)}%`,
          }))}
          onChange={(zoom) => selectTypography({ zoom: Number(zoom) })}
          hint="Scales the whole window, the way a browser's zoom does."
        />
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

        <CheckField
          label="Spine"
          hint="The rule at the rail. Its colour names the conversation a run belongs to, which nothing else on the row says."
          checked={presentation.spine}
          onChange={(spine) => selectPresentation({ spine })}
        />

        <CheckField
          label="Angle brackets around nicknames"
          hint="<alice> at the head of a run, as clients that named every line wrote it."
          checked={presentation.nickBrackets}
          onChange={(nickBrackets) => selectPresentation({ nickBrackets })}
        />
      </Group>

      {broken.length > 0 && (
        <Group title="Themes that would not load">
          <ul className="flex flex-col gap-3">
            {broken.map((theme) => (
              <li key={theme.id} className="flex flex-col gap-1">
                <h4 className="font-mono text-[12px] text-[var(--text-primary)]">
                  {theme.id}
                </h4>
                {theme.problems.map((problem) => (
                  <p
                    key={problem}
                    className="selectable text-[11px] leading-[1.6] text-[var(--danger)]"
                  >
                    {problem}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </Group>
      )}

      <p className="text-[11px] text-[var(--text-muted)]">
        Themes live in <span className="font-mono">&lt;app data&gt;/themes</span>. A theme is
        a folder holding a theme.json and a theme.css; copy one in and it appears here
        without a relaunch.
      </p>
    </div>
  );
}

/**
 * Copies a theme folder into the themes directory, and opens that directory.
 *
 * Nothing is added to the list here. The backend watches the directory and
 * republishes it, which is the same route a theme copied in by hand takes — so
 * a theme that installs and a theme that is dropped in arrive by one path and
 * cannot disagree about what is on disk. What this does do is select what it
 * installed: choosing it is the reason somebody installed it, and a theme that
 * landed and did nothing reads as an install that failed.
 */
function InstallTheme() {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function install() {
    setProblem(null);

    let source: string | null;
    try {
      source = await chooseFolder("Choose a theme folder");
    } catch (reason) {
      setProblem(reasonOr(reason, "The folder picker could not be opened."));
      return;
    }
    if (source === null) return;

    setBusy(true);
    try {
      selectTheme(await ipc.installTheme(source));
    } catch (reason) {
      setProblem(reasonOr(reason, "That theme could not be installed."));
    }
    setBusy(false);
  }

  async function reveal() {
    setProblem(null);
    try {
      await revealFolder(await ipc.themesDirectory());
    } catch (reason) {
      setProblem(reasonOr(reason, "The themes folder could not be opened."));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SecondaryButton label="Install a theme from a folder" onClick={() => void install()}>
          {busy ? "Installing" : "Install a theme"}
        </SecondaryButton>
        <SecondaryButton label="Open the themes folder" onClick={() => void reveal()}>
          Open themes folder
        </SecondaryButton>
      </div>
      {problem && <Note error>{problem}</Note>}
    </div>
  );
}

/** Tauri rejects with the handler's own sentence, which is written for a
 * reader; anything else is a bug in the bridge and gets the caller's. */
function reasonOr(reason: unknown, fallback: string): string {
  return typeof reason === "string" && reason.trim() !== "" ? reason : fallback;
}

/** The palette's line for a theme, in the palette's order — see `describeTheme`
 * in src/components/palette/candidates.ts. Two places name a theme and they
 * should read the same; the function there is private to that module, so the
 * shape is what is shared rather than the code. */
function describeTheme(theme: Theme, inUse: boolean): string {
  const { author, version, appearance } = theme.manifest;
  return `${appearance} · ${author} · ${version}${inUse ? " · in use" : ""}`;
}
