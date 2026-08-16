import { useState } from "react";
import { Note, SecondaryButton } from "@/components/onboarding/fields";
import { chooseFolder, ipc, reasonOr, revealFolder } from "@/lib/ipc";
import { selectTheme } from "@/lib/theme";
import { useAppStore } from "@/store";
import { AppearanceRail } from "./AppearanceRail";
import { Preview } from "./Preview";
import { ThemeCards } from "./ThemeCards";
import { TokenEditor } from "./TokenEditor";

/**
 * The themes that loaded, everything about how the timeline is set, and the
 * themes that did not load — over a sample of the conversation all of it
 * applies to.
 *
 * Nothing here is committed or cancelled. Every control writes through
 * src/lib/theme/session.ts the moment it is used, which paints this window and
 * tells the client's, so Done closes the window rather than accepting
 * anything. That is also why the preview is worth its room: with no Apply
 * step, the sample above the controls is the whole of the feedback.
 */
export function AppearancePage({ onDone }: { onDone: () => void }) {
  const themes = useAppStore((s) => s.themes);
  const broken = useAppStore((s) => s.brokenThemes);
  const themeId = useAppStore((s) => s.themeId);
  const density = useAppStore((s) => s.density);
  const sidebarCompact = useAppStore((s) => s.sidebarCompact);
  const presentation = useAppStore((s) => s.presentation);
  const typography = useAppStore((s) => s.typography);
  const overrides = useAppStore((s) => s.overrides);

  const [editing, setEditing] = useState<string | null>(null);

  /* Only the theme in force is painted, edits and all: src/lib/theme/apply.ts
   * merges `overrides[theme.id]` and nothing else, which is what stops one
   * theme's accent landing on another's surfaces. An editor opened on a theme
   * that is not in force would therefore commit values nobody could see, so
   * opening it is also choosing the theme. */
  function edit(id: string) {
    if (id !== themeId) selectTheme(id);
    setEditing(id);
  }

  /* A theme deleted from the directory while its editor is open leaves nothing
   * to edit, and the catalogue is re-read whenever the directory changes. Back
   * to the page rather than a screen with no tokens on it. */
  const editingTheme = themes.find((theme) => theme.id === editing) ?? null;
  if (editingTheme !== null) {
    return (
      <div className="mx-auto max-w-[900px] px-8 py-6">
        <TokenEditor theme={editingTheme} onBack={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-8 py-6">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)]">Appearance</h2>
          <p className="text-[12px] text-[var(--text-muted)]">
            What the window looks like, and how a conversation is set in it. Every change is
            applied as you make it.
          </p>
        </div>
        {/* Unlabelled: "Done" is its own accessible name, and the title bar's
            X already answers to "Close settings". Two controls under one name
            is one control as far as a screen reader is concerned. */}
        <SecondaryButton onClick={onDone}>Done</SecondaryButton>
      </header>

      {/* The rail goes beside the preview where there is room for both, and
          stacks under it rather than squeezing the sample where there is not.
          Measured against the pane rather than the window: this page is a pane
          of the client's layout now, and a viewport breakpoint kept the rail
          beside a 476px pane in a 1200px window, which is where the row of
          accents was found running off the edge. */}
      <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_290px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Preview />

          <ThemeCards
            themes={themes}
            themeId={themeId}
            overrides={overrides}
            onEdit={edit}
          />

          <InstallTheme />

          {broken.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-[10px] font-semibold tracking-[0.09em] text-[var(--text-muted)] uppercase">
                Themes that would not load
              </h3>
              {/* Listed whole. Each sentence names the field or the property
                  that is wrong and what belongs in it, and is written to be
                  acted on by the person holding the file. */}
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
            </section>
          )}

          <p className="text-[11px] text-[var(--text-muted)]">
            Themes live in <span className="font-mono">&lt;app data&gt;/themes</span>. A theme
            is a folder holding a theme.json and a theme.css; copy one in and it appears here
            without a relaunch.
          </p>
        </div>

        <AppearanceRail
          theme={themes.find((theme) => theme.id === themeId) ?? null}
          themeId={themeId}
          overrides={overrides}
          density={density}
          sidebarCompact={sidebarCompact}
          presentation={presentation}
          typography={typography}
          onEditTokens={() => edit(themeId)}
        />
      </div>
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
