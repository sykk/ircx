import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ipc } from "@/lib/ipc";
import { displayChord } from "@/lib/keybindings";
import { runConnectionCommand } from "@/components/composer/commands";
import { applyTheme, selectDensity, selectTheme } from "@/lib/theme";
import { useAppStore } from "@/store";
import { SERVER_TARGET } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  buildCandidates,
  commandLineCandidate,
  type Candidate,
  type CommandContext,
} from "./candidates";
import { PaletteGroup } from "./PaletteGroup";
import { filterMatches, flatten, rankMatches, type FilterState, type RankedResult } from "./ranking";

const RESULT_LIMIT = 60;

/** Last keystroke's survivors, per candidate list. Keyed on the array itself,
 * so a rebuilt list never inherits indices that pointed into the old one. */
const narrowing = new WeakMap<Candidate[], FilterState>();

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}

/** Mounted only while open, so the candidate list is built on open and the
 * palette costs nothing while the user is reading. */
function Palette() {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);

  const channels = useAppStore((s) => s.channels);
  const queries = useAppStore((s) => s.queries);
  const networks = useAppStore((s) => s.networks);
  const networkOrder = useAppStore((s) => s.networkOrder);
  const recent = useAppStore((s) => s.recent);
  const views = useAppStore((s) => s.views);
  const activeViewId = useAppStore((s) => s.activeViewId);
  const themes = useAppStore((s) => s.themes);
  const brokenThemes = useAppStore((s) => s.brokenThemes);
  const themeId = useAppStore((s) => s.themeId);
  const density = useAppStore((s) => s.density);

  const candidates = useMemo(
    () =>
      buildCandidates({
        channels,
        queries,
        networks,
        networkOrder,
        themes,
        brokenThemes,
        themeId,
        density,
      }),
    [channels, queries, networks, networkOrder, themes, brokenThemes, themeId, density],
  );

  const where = useMemo<CommandContext | null>(() => {
    const view = activeViewId ? views[activeViewId] : undefined;
    const id = view?.network && networks[view.network] ? view.network : networkOrder[0];
    if (!id) return null;
    return {
      network: id,
      networkName: networks[id]?.name ?? id,
      target: view?.network === id ? view.target : SERVER_TARGET,
    };
  }, [activeViewId, views, networks, networkOrder]);

  const groups = useMemo(() => {
    const state = filterMatches(candidates, query, narrowing.get(candidates) ?? null);
    narrowing.set(candidates, state);
    const ranked = rankMatches(candidates, state, recent, RESULT_LIMIT);

    // Above the ranked list rather than in it: it is the query itself, so it
    // never competes with a name match and never needs a score.
    const line = commandLineCandidate(query, where);
    if (!line) return ranked;
    return [{ kind: line.kind, results: [{ candidate: line, score: 0, positions: [] }] }, ...ranked];
  }, [candidates, query, recent, where]);

  const results = useMemo(() => flatten(groups), [groups]);
  const at = Math.min(selected, Math.max(0, results.length - 1));

  // Live preview: moving onto a theme puts it on the window, and moving off it
  // — or closing the palette — puts the chosen one back. A swatch would have to
  // lie about what a theme looks like; the window cannot.
  const highlighted = results[at]?.candidate.action;
  const preview = highlighted?.type === "theme" ? highlighted.id : themeId;
  useEffect(() => {
    applyTheme(themes.find((theme) => theme.id === preview) ?? null);
    // Read the chosen theme when the preview ends, not when it began. Choosing
    // one closes the palette, so this cleanup is the last thing to touch the
    // root — restoring the captured id would undo the choice that closed it.
    return () => {
      const chosen = useAppStore.getState().themeId;
      applyTheme(themes.find((theme) => theme.id === chosen) ?? null);
    };
  }, [preview, themeId, themes]);

  const close = () => useAppStore.getState().togglePalette(false);

  function run(index: number) {
    const result = results[index];
    if (!result) return;
    const store = useAppStore.getState();
    const action = result.candidate.action;

    switch (action.type) {
      case "activate":
        store.showTarget({ network: action.network, target: action.target });
        break;
      case "refine":
        setQuery(action.text);
        setSelected(0);
        setError(null);
        return;
      case "run":
        void (async () => {
          // A command about the connection is performed rather than sent:
          // there may be no session to send it to.
          try {
            if (await runConnectionCommand(action.input, action.network)) {
              close();
              return;
            }
          } catch (reason) {
            setError(String(reason));
            return;
          }
          const outcome = await ipc.submitInput(
            action.network,
            action.target,
            action.input,
          );
          if (outcome.kind === "rejected") {
            setError(outcome.value);
            return;
          }
          const joined = channelJoinedBy(action.input);
          if (joined) store.showTarget({ network: action.network, target: joined });
          close();
        })().catch(report);
        return;
      case "split":
        store.splitActiveView(action.direction);
        break;
      case "closePane":
        if (store.activeViewId) store.closeView(store.activeViewId);
        break;
      case "toggleRoster":
        if (store.activeViewId) store.toggleRoster(store.activeViewId);
        break;
      case "search":
        store.toggleSearch(true);
        break;
      case "openSetup":
        store.openSetup(action.network);
        break;
      case "plugins":
        store.togglePlugins(true);
        break;
      case "archive":
        store.toggleArchive(true);
        break;
      case "uploads":
        store.toggleUpload(true);
        break;
      case "appearance":
        store.toggleAppearance(true);
        break;
      case "connect":
        attempt(ipc.connectNetwork(action.network));
        return;
      case "disconnect":
        attempt(ipc.disconnectNetwork(action.network));
        return;
      case "theme":
        // The repaint `selectTheme` does is one the preview effect has already
        // done, so it is not what this is for: choosing a theme anywhere in the
        // app has to leave the same three things set, and two call sites doing
        // it by hand is how they come apart.
        selectTheme(action.id);
        break;
      case "density":
        selectDensity(action.id);
        break;
      case "themeProblem":
        setError(`${action.id}: ${action.problems.join(" ")}`);
        return;
    }
    close();
  }

  /** A network command that fails leaves the palette open with the reason,
   * which is the only place to show it before the shell has a toast. */
  function attempt(call: Promise<void>) {
    call.then(close, report);
  }

  function report(reason: unknown) {
    setError(String(reason));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // An open IME composition owns the keys: its Enter commits a candidate,
    // not the selected result.
    if (event.nativeEvent.isComposing) return;
    const move = (delta: number) => {
      if (results.length === 0) return;
      setSelected((((at + delta) % results.length) + results.length) % results.length);
    };

    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "n":
      case "N":
        if (!event.ctrlKey) return;
        move(1);
        break;
      case "p":
      case "P":
        if (!event.ctrlKey) return;
        move(-1);
        break;
      case "Enter":
        run(at);
        break;
      case "Escape":
        close();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center pt-[12vh]" onMouseDown={close}>
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]"
      >
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="palette-results"
          aria-activedescendant={results.length > 0 ? `palette-result-${at}` : undefined}
          aria-label="Search channels, queries, networks, and commands"
          placeholder="Jump to a channel, or run a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
            setError(null);
          }}
          className="selectable border-b border-[var(--border-subtle)] bg-transparent px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />

        <div id="palette-results" role="listbox" aria-label="Results" className="overflow-y-auto pb-2">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[var(--text-muted)]">
              Nothing matches {query.trim()}
            </p>
          ) : (
            groups.map((group, i) => (
              <PaletteGroup
                key={group.kind}
                group={group}
                offset={offsetOf(groups, i)}
                selected={at}
                onRun={run}
              />
            ))
          )}
        </div>

        {error && (
          <p role="alert" className="border-t border-[var(--border-subtle)] px-4 py-2 text-[var(--danger)]">
            {error}
          </p>
        )}

        <footer className="flex gap-4 border-t border-[var(--border-subtle)] px-4 py-2 text-[11px] text-[var(--text-faint)]">
          <Hint keys="↑↓" label="Move" />
          <Hint keys="↵" label={results[at]?.candidate.kind === "run" ? "Run" : "Open"} />
          <Hint keys={displayChord("Escape")} label="Close" />
          <span className="ml-auto">{summarise(results)}</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * The one channel `input` joins, if it joins exactly one.
 *
 * A join run from the palette should leave the pane in the channel: the palette
 * is the only route to a join before any conversation is open, and that is
 * exactly when the pane behind it reads "No conversation open".
 */
function channelJoinedBy(input: string): string | null {
  const [name = "", channel = ""] = input.slice(1).split(/\s+/);
  if (name.toLowerCase() !== "join") return null;
  return /^[#&!+][^,]*$/.test(channel) ? channel : null;
}

function offsetOf(groups: { results: RankedResult[] }[], index: number): number {
  let total = 0;
  for (let i = 0; i < index; i++) total += groups[i]!.results.length;
  return total;
}

function summarise(results: RankedResult[]): string {
  if (results.length === 0) return "";
  return results.length === RESULT_LIMIT
    ? `first ${RESULT_LIMIT} results`
    : `${results.length} result${results.length === 1 ? "" : "s"}`;
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-1 text-[var(--badge-text)]">
        {keys}
      </kbd>
      {label}
    </span>
  );
}
