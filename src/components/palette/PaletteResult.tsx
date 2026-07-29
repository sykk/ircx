import clsx from "clsx";
import type { RankedResult } from "./ranking";

interface Props {
  result: RankedResult;
  index: number;
  selected: boolean;
  onRun: (index: number) => void;
}

export function PaletteResult({ result, index, selected, onRun }: Props) {
  const { candidate, positions } = result;

  return (
    <li
      id={`palette-result-${index}`}
      role="option"
      aria-selected={selected}
      ref={(el) => {
        if (selected) el?.scrollIntoView?.({ block: "nearest" });
      }}
      onClick={() => onRun(index)}
      className={clsx(
        "mx-1 flex cursor-pointer items-baseline gap-3 rounded-[var(--radius-sm)] px-3 py-1.5",
        selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]",
      )}
    >
      <span
        className={clsx(
          "shrink-0 font-mono",
          selected ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]",
        )}
      >
        <Highlighted text={candidate.label} positions={positions} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">
        {candidate.detail}
      </span>
      {candidate.unread > 0 && (
        <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--badge-bg)] px-1.5 text-[11px] text-[var(--badge-text)]">
          {candidate.unread}
        </span>
      )}
    </li>
  );
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;

  const marked = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];

  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i]!, hit });
  }

  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <b key={i} className="font-semibold text-[var(--accent-hover)]">
            {part.text}
          </b>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
