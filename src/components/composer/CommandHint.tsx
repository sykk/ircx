import type { SlashCommand } from "./commands";

export function CommandHint({ commands }: { commands: SlashCommand[] }) {
  return (
    <div
      className="absolute bottom-full left-0 mb-1 max-h-[220px] w-[320px] overflow-y-auto rounded-[var(--radius-md)] border py-1"
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-default)",
        boxShadow: "var(--shadow-overlay)",
      }}
      role="listbox"
      aria-label="Commands"
    >
      {commands.map((command, i) => (
        <div
          key={command.name}
          role="option"
          aria-selected={i === 0}
          className="flex items-baseline gap-2 px-3 py-1 text-[12px]"
          style={{ background: i === 0 ? "var(--surface-hover)" : undefined }}
        >
          <span
            className="font-[family-name:var(--font-mono)] shrink-0"
            style={{ color: "var(--text-primary)" }}
          >
            {command.usage}
          </span>
          <span className="truncate" style={{ color: "var(--text-muted)" }}>
            {command.summary}
          </span>
        </div>
      ))}
    </div>
  );
}
