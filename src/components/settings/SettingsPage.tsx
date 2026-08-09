import { createContext, use, useState, type ReactNode } from "react";
import { SecondaryButton } from "@/components/onboarding/fields";

/**
 * Whether a page has a request in flight, told to the window around it.
 *
 * As sheets, these pages guarded their own way out: closing mid-request loses
 * the answer, so an install lands with its permissions never asked and a
 * failed save reports into a screen that has gone. A page cannot guard the
 * window's Escape by itself — the keystroke is caught on the document, above
 * every page — so it says it is busy and the window declines to close.
 *
 * Only the two pages that make requests set it. The window's own controls, and
 * the desktop's, are not covered and cannot be: closing a window is the
 * operating system's to allow.
 */
const Busy = createContext<{ busy: boolean; setBusy: (busy: boolean) => void }>({
  busy: false,
  setBusy: () => {},
});

export function SettingsBusy({ children }: { children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return <Busy value={{ busy, setBusy }}>{children}</Busy>;
}

/** Reads the flag, for the window deciding whether Escape closes it. */
export function useSettingsBusy(): boolean {
  return use(Busy).busy;
}

/** Reports it, for a page that has just started or finished a request. */
export function useReportBusy(): (busy: boolean) => void {
  return use(Busy).setBusy;
}

/**
 * The heading every section is set under, and the way out.
 *
 * Shared so the four pages agree about where the title sits and what the
 * button says, which they did not when each was a sheet of its own: the
 * plugins sheet said Done and the archive sheet said Close, for the same act.
 *
 * Nothing here commits or cancels. Every control on every page writes the
 * moment it is used — that was true of the sheets and is why they had no Apply
 * either — so Done closes the window rather than accepting anything.
 */
export function SettingsPage({
  title,
  blurb,
  onDone,
  children,
}: {
  title: string;
  /** Under the heading. A node rather than a string because the archive's says
   * how much is kept, which is a number it has to read first. */
  blurb: ReactNode;
  onDone: () => void;
  children: ReactNode;
}) {
  const busy = useSettingsBusy();
  return (
    <div className="flex flex-col gap-6 px-8 py-6">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-semibold text-[var(--text-primary)]">{title}</h2>
          <div className="text-[12px] text-[var(--text-muted)]">{blurb}</div>
        </div>
        {/* Unlabelled: "Done" is its own accessible name, and the title bar's
            X already answers to "Close settings". Two controls under one name
            is one control as far as a screen reader is concerned. */}
        <SecondaryButton disabled={busy} onClick={onDone}>
          Done
        </SecondaryButton>
      </header>

      {children}
    </div>
  );
}
