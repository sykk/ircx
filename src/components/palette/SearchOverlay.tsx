import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { formatClock } from "@/components/timeline/rows";
import { ipc } from "@/lib/ipc";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { useAppStore } from "@/store";
import { targetKey, useActiveTarget } from "@/store/selectors";
import type { SearchHit } from "@/types";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { loadSavedSearches, removeSavedSearch, saveSearch } from "@/lib/savedSearches";
import { Icon } from "@/components/common/Icon";

const HIT_LIMIT = 50;
const CONTEXT_LIMIT = 200;
const DEBOUNCE_MS = 150;
/**
 * One character is a query the archive can now answer, in any script. It was
 * two, which was two of `String.length` — UTF-16 code units — so `🔥` counted
 * as two and passed while `落` counted as one and was refused. A whole word in
 * Japanese and a whole message in emoji were on opposite sides of a line
 * neither of them was drawn for. #378.
 *
 * A single character is answered by a scan where no index holds it, which is
 * 15 ms against 100,000 messages and happens after the debounce below.
 */
const MIN_QUERY = 1;
type SearchAge = "any" | "day" | "week" | "month";

export function SearchOverlay() {
  const open = useAppStore((s) => s.searchOpen);
  return open ? <Search /> : null;
}

function Search() {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

  const active = useActiveTarget();
  const [query, setQuery] = useState("");
  const [sender, setSender] = useState("");
  const [age, setAge] = useState<SearchAge>("any");
  const [openedAt] = useState(Date.now);
  const [saved, setSaved] = useState(loadSavedSearches);
  const [mode, setMode] = useState<"search" | "bookmarks">("search");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  const [selected, setSelected] = useState(0);
  const clockFormat = useAppStore((s) => s.presentation.clock);

  const network = active?.network ?? null;
  const target = active?.target ?? null;
  const text = query.trim();
  const senderFilter = sender.trim() || null;
  const after = searchAfter(age, openedAt);
  // Too short to search: the last answer stays in state but is not shown, so
  // clearing it would only cost a render.
  const shown = mode === "search" && [...text].length < MIN_QUERY ? [] : hits;

  useEffect(() => {
    if (mode === "search" && [...text].length < MIN_QUERY) return;

    let live = true;
    const timer = setTimeout(() => {
      const request = mode === "bookmarks"
        ? ipc.listBookmarks(network, target, HIT_LIMIT)
        : ipc.searchHistory({
            query: text,
            network,
            target,
            sender: senderFilter,
            after,
            limit: HIT_LIMIT,
          });
      request.then(
        (found) => {
          if (!live) return;
          setHits(found);
          setError(null);
          setSelected(0);
        },
        (reason: unknown) => {
          if (!live) return;
          setHits([]);
          setError(String(reason));
        },
      );
    }, DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, network, target, senderFilter, after, mode]);

  const close = () => useAppStore.getState().toggleSearch(false);

  async function jump(index: number) {
    const hit = shown[index];
    if (!hit) return;
    try {
      const messages = await ipc.loadHistoryAround(
        hit.message.network,
        hit.message.target,
        hit.message.id,
        CONTEXT_LIMIT,
      );
      if (!messages.some((message) => message.id === hit.message.id)) {
        setError("That archived message is no longer available.");
        return;
      }
      const store = useAppStore.getState();
      store.replaceHistory(targetKey(hit.message.network, hit.message.target), messages);
      store.showTarget({ network: hit.message.network, target: hit.message.target });
      const view = useAppStore.getState().activeViewId;
      if (view) useAppStore.getState().setMessageJump(view, hit.message.id);
      close();
    } catch (reason) {
      setError(String(reason));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // An open IME composition owns the keys: its Enter commits a candidate,
    // not the selected hit.
    if (event.nativeEvent.isComposing) return;
    const move = (delta: number) => {
      if (shown.length === 0) return;
      setSelected((((selected + delta) % shown.length) + shown.length) % shown.length);
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
        void jump(selected);
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
    <div className="fixed inset-0 z-50 flex justify-center pt-[10vh]" onMouseDown={close}>
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search history"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex max-h-[74vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]"
      >
        <div className="flex border-b border-[var(--border-subtle)] px-3 pt-2">
          {(["search", "bookmarks"] as const).map((choice) => (
            <button key={choice} type="button" aria-pressed={mode === choice} onClick={() => { setMode(choice); setHits([]); setSelected(0); }} className={clsx("rounded-t-[var(--radius-sm)] px-3 py-1.5 text-[12px] capitalize", mode === choice ? "bg-[var(--surface-active)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)]")}>{choice}</button>
          ))}
        </div>
        {mode === "search" && (
          <>
            <div className="flex border-b border-[var(--border-subtle)]">
              <input
                autoFocus
                type="search"
                aria-label={target ? `Search ${target}` : "Search history"}
                placeholder={target ? `Search ${target}` : "Search every conversation"}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                }}
                className="selectable min-w-0 flex-1 bg-transparent px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              <button
                type="button"
                disabled={text === "" || saved.includes(text)}
                onClick={() => setSaved(saveSearch(text))}
                className="px-4 text-[12px] text-[var(--accent)] disabled:text-[var(--text-muted)]"
              >
                Save
              </button>
            </div>
            <div className="flex gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-[var(--text-muted)]">
                From
                <select
                  aria-label="Search age"
                  value={age}
                  onChange={(event) => setAge(event.target.value as SearchAge)}
                  className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--text-secondary)] outline-none"
                >
                  <option value="any">Any time</option>
                  <option value="day">Past 24 hours</option>
                  <option value="week">Past 7 days</option>
                  <option value="month">Past 30 days</option>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-[var(--text-muted)]">
                Nick
                <input
                  aria-label="Search sender"
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  placeholder="Anyone"
                  className="selectable min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-muted)]"
                />
              </label>
            </div>
            {saved.length > 0 && (
              <div aria-label="Saved searches" className="flex flex-wrap gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
                {saved.map((held) => (
                  <span key={held} className="inline-flex rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--surface-raised)]">
                    <button type="button" onClick={() => { setQuery(held); setSelected(0); }} className="max-w-48 truncate px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                      {held}
                    </button>
                    <button type="button" aria-label={`Remove saved search ${held}`} onClick={() => setSaved(removeSavedSearch(held))} className="border-l border-[var(--border-subtle)] px-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)]">
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <ul role="listbox" aria-label="Search results" className="overflow-y-auto py-1">
          {shown.map((hit, i) => (
            <li
              key={hit.message.id}
              role="option"
              aria-selected={i === selected}
              ref={(el) => {
                if (i === selected) el?.scrollIntoView?.({ block: "nearest" });
              }}
              onClick={() => void jump(i)}
              className={clsx(
                "mx-1 cursor-pointer rounded-[var(--radius-sm)] px-3 py-1.5",
                i === selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
              )}
            >
              <div className="flex items-baseline gap-2 text-[11px] text-[var(--text-muted)]">
                <span className="text-[var(--text-secondary)]">{hit.message.sender.nick}</span>
                <span>{hit.message.target}</span>
                <span className="ml-auto">
                  {formatClock(hit.message.timestamp, clockFormat)}
                </span>
              </div>
              <p className="selectable text-[var(--text-primary)]">
                <Snippet snippet={hit.snippet} />
              </p>
            </li>
          ))}
        </ul>

        {error ? (
          <p role="alert" className="border-t border-[var(--border-subtle)] px-4 py-3 text-[var(--danger)]">
            {error}
          </p>
        ) : (
          shown.length === 0 && (
            <p className="px-4 py-6 text-center text-[var(--text-muted)]">
              {mode === "bookmarks"
                ? "No bookmarks in this conversation"
                : [...text].length < MIN_QUERY
                ? "Search this conversation"
                : `Nothing matches ${text}`}
            </p>
          )
        )}
      </div>
    </div>
  );
}

export function searchAfter(age: SearchAge, now = Date.now()): string | null {
  const days = age === "day" ? 1 : age === "week" ? 7 : age === "month" ? 30 : 0;
  return days === 0 ? null : new Date(now - days * 86_400_000).toISOString();
}

/** The backend hands back an FTS5 snippet with `<mark>` around the hits. It is
 * rendered as text nodes rather than HTML: message text is whatever a stranger
 * on IRC typed, and the worst a stray `<mark>` in it can do here is highlight
 * the wrong word. */
function Snippet({ snippet }: { snippet: string }) {
  return (
    <>
      {snippetSegments(stripIrcFormatting(snippet)).map((segment, i) =>
        segment.mark ? (
          <mark key={i} className="rounded-[var(--radius-sm)] bg-[var(--mention-bg)] text-[var(--accent-hover)]">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function snippetSegments(snippet: string): { text: string; mark: boolean }[] {
  const segments: { text: string; mark: boolean }[] = [];
  let mark = false;

  for (const part of snippet.split(/(<\/?mark>)/)) {
    if (part === "<mark>") mark = true;
    else if (part === "</mark>") mark = false;
    else if (part !== "") segments.push({ text: part, mark });
  }

  return segments;
}
