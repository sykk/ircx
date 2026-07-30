import { useEffect, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ipc } from "@/lib/ipc";
import { stripIrcFormatting } from "@/lib/ircFormat";
import { useAppStore } from "@/store";
import { useActiveTarget } from "@/store/selectors";
import type { SearchHit } from "@/types";

const HIT_LIMIT = 50;
const DEBOUNCE_MS = 150;
const MIN_QUERY = 2;

interface Props {
  /** Called after the target is activated, so the timeline can scroll to the
   * message. Selection still works without it; it just lands at the bottom. */
  onJump?: (hit: SearchHit) => void;
}

export function SearchOverlay(props: Props) {
  const open = useAppStore((s) => s.searchOpen);
  return open ? <Search {...props} /> : null;
}

function Search({ onJump }: Props) {
  const active = useActiveTarget();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const network = active?.network ?? null;
  const target = active?.target ?? null;
  const text = query.trim();
  // Too short to search: the last answer stays in state but is not shown, so
  // clearing it would only cost a render.
  const shown = text.length < MIN_QUERY ? [] : hits;

  useEffect(() => {
    if (text.length < MIN_QUERY) return;

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

  function jump(index: number) {
    const hit = shown[index];
    if (!hit) return;
    useAppStore
      .getState()
      .setActive({ network: hit.message.network, target: hit.message.target });
    onJump?.(hit);
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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
        jump(selected);
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
        role="dialog"
        aria-modal="true"
        aria-label="Search history"
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
              onClick={() => jump(i)}
              className={clsx(
                "mx-1 cursor-pointer rounded-[var(--radius-sm)] px-3 py-1.5",
                i === selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
              )}
            >
              <div className="flex items-baseline gap-2 text-[11px] text-[var(--text-muted)]">
                <span className="text-[var(--text-secondary)]">{hit.message.sender.nick}</span>
                <span>{hit.message.target}</span>
                <span className="ml-auto">{clockTime(hit.message.timestamp)}</span>
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
              {text.length < MIN_QUERY ? "Type at least two characters" : `Nothing matches ${text}`}
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

function clockTime(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
