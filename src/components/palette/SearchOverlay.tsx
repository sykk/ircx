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

export function SearchOverlay() {
  const open = useAppStore((s) => s.searchOpen);
  return open ? <Search /> : null;
}

function Search() {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

  const active = useActiveTarget();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  const [selected, setSelected] = useState(0);
  const clockFormat = useAppStore((s) => s.presentation.clock);

  const network = active?.network ?? null;
  const target = active?.target ?? null;
  const text = query.trim();
  // Too short to search: the last answer stays in state but is not shown, so
  // clearing it would only cost a render.
  const shown = [...text].length < MIN_QUERY ? [] : hits;

  useEffect(() => {
    if ([...text].length < MIN_QUERY) return;

    let live = true;
    const timer = setTimeout(() => {
      ipc.searchHistory({ query: text, network, target, limit: HIT_LIMIT }).then(
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
  }, [text, network, target]);

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
          className="selectable border-b border-[var(--border-subtle)] bg-transparent px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />

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
              {[...text].length < MIN_QUERY
                ? "Search this conversation"
                : `Nothing matches ${text}`}
            </p>
          )
        )}
      </div>
    </div>
  );
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
