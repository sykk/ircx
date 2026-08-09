import clsx from "clsx";
import { Icon } from "@/components/common/Icon";
import { SECTIONS, type SectionId } from "./sections";

/**
 * The section list. A `tablist` rather than a `nav` of links: nothing here
 * navigates, each row swaps the panel beside it, and that is the pattern a
 * screen reader is told about by name.
 */
export function SettingsSidebar({
  section,
  onChoose,
}: {
  section: SectionId;
  onChoose: (section: SectionId) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-4 border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] px-3 py-5">
      <h1 className="px-2 text-[15px] font-semibold text-[var(--text-primary)]">Settings</h1>

      <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5">
        {SECTIONS.map((entry) => {
          const chosen = entry.id === section;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-tab-${entry.id}`}
              aria-selected={chosen}
              aria-controls={`settings-panel-${entry.id}`}
              onClick={() => onChoose(entry.id)}
              className={clsx(
                "flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-2 text-left text-[13px]",
                chosen
                  ? "bg-[var(--surface-hover)] text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              )}
            >
              <Icon name={entry.icon} size={15} />
              {entry.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
