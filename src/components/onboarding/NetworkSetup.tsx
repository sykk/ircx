import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import { draftOf, emptyDraft } from "./config";
import { Onboarding, type OnboardingStart } from "./Onboarding";

/**
 * Onboarding's forms reached after first launch: the sidebar's `+` for a
 * network that does not exist yet, the channel header's ⋮ for the one being
 * read. Onboarding itself only ever appears when no network is configured.
 */
export function NetworkSetup() {
  const setup = useAppStore((s) => s.setup);
  if (setup === null) return null;
  // Keyed so opening a second network starts its form from scratch rather than
  // inheriting the last one's draft.
  return <Sheet key={setup.network ?? "new"} network={setup.network} />;
}

function Sheet({ network }: { network: string | null }) {
  const closeSetup = useAppStore((s) => s.closeSetup);
  const [start, setStart] = useState<OnboardingStart | null>(
    network === null ? { step: "server", draft: emptyDraft() } : null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (network === null) return;

    let live = true;
    void ipc.listNetworkConfigs().then(
      (configs) => {
        if (!live) return;
        const config = configs.find((c) => c.id === network);
        // `draftOf` leaves the password null because `save_network` writes it
        // to the keyring and never reads it back; the form says so rather than
        // standing empty.
        if (config) setStart({ step: "advanced", draft: draftOf(config) });
        else setError("That network is no longer configured.");
      },
      (reason: unknown) => {
        if (!live) return;
        setError(
          typeof reason === "string" && reason.length > 0
            ? reason
            : "The saved networks could not be read.",
        );
      },
    );

    return () => {
      live = false;
    };
  }, [network]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={closeSetup}
    >
      <div className="absolute inset-0 bg-[var(--scrim)]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={network === null ? "Add a network" : "Network settings"}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          closeSetup();
        }}
        className="relative flex max-h-[88vh] w-[min(560px,92vw)] flex-col overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)] shadow-[var(--shadow-overlay)]"
      >
        {error !== null ? (
          <p role="alert" className="p-6 text-[var(--danger)]">
            {error}
          </p>
        ) : start === null ? (
          <p className="p-6 text-[var(--text-muted)]">Reading the saved settings…</p>
        ) : (
          <Onboarding onDone={closeSetup} start={start} />
        )}
      </div>
    </div>
  );
}
