import { AppShell } from "@/components/shell/AppShell";

export function App() {
  return (
    <AppShell>
      <div className="grid h-full place-items-center text-[var(--text-muted)]">
        No conversation selected
      </div>
    </AppShell>
  );
}
