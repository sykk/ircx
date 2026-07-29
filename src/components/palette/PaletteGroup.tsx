import { KIND_LABELS } from "./candidates";
import { PaletteResult } from "./PaletteResult";
import type { RankedGroup } from "./ranking";

interface Props {
  group: RankedGroup;
  /** Position of this group's first result in the flattened list. */
  offset: number;
  selected: number;
  onRun: (index: number) => void;
}

export function PaletteGroup({ group, offset, selected, onRun }: Props) {
  const label = KIND_LABELS[group.kind];

  return (
    <section role="group" aria-label={label}>
      <h2 className="px-4 pt-2 pb-1 text-[10px] tracking-wider text-[var(--text-faint)] uppercase">
        {label}
      </h2>
      <ul role="presentation">
        {group.results.map((result, i) => (
          <PaletteResult
            key={result.candidate.id}
            result={result}
            index={offset + i}
            selected={offset + i === selected}
            onRun={onRun}
          />
        ))}
      </ul>
    </section>
  );
}
