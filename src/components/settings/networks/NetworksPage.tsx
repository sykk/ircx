import { useEffect, useRef, useState } from "react";
import { draftOf, emptyDraft } from "@/components/onboarding/config";
import { Onboarding, type OnboardingStart } from "@/components/onboarding/Onboarding";
import { useAnnounce } from "@/hooks/useAnnounce";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { NetworkConfig } from "@/types";
import { NetworkList } from "./NetworkList";

/**
 * The networks this client is configured for, and the form that configures
 * one.
 *
 * The form is the onboarding flow, unchanged and in one piece: pick, fill in,
 * save, and then watch the connection it started. That last step is the whole
 * reason this section did not exist while settings was a second window — a
 * window with no event bridge cannot see a connection happen. This page is in
 * the client, so `Connecting` reads the same store the sidebar does.
 *
 * Which screen it is on is `AppState.setup` rather than state of its own,
 * because the sidebar's `+`, a network row's menu, the channel header's `⋮`
 * and the palette all open settings *on a network*, and none of them is this
 * component.
 */
export function NetworksPage({ onDone }: { onDone: () => void }) {
  const setup = useAppStore((s) => s.setup);
  const closeSetup = useAppStore((s) => s.closeSetup);
  const here = useRef<HTMLDivElement>(null);

  /* Focus follows the form out. The form opens with a field focused, and when
   * that field unmounts the browser leaves focus on `body` — outside the
   * dialog's React tree, where its own key handler never runs. Escape would
   * then do nothing until something inside was clicked, which is the way out of
   * settings gone. */
  useEffect(() => {
    if (setup !== null || document.activeElement !== document.body) return;
    here.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, [setup]);

  return (
    /* `contents`, so this box is a place to hang a ref and a handler and not a
       layer of layout. Escape from the form goes back to the list, and this is
       the only screen in settings that claims the key: the dialog around it
       declines Escape from inside a field — `isTextEntry`, so a value being
       typed is what the keystroke abandons — and this form opens with one
       focused, which left Escape doing nothing at all on the screen a dialog of
       its own used to close. Back is what it abandons the form to. */
    <div
      ref={here}
      className="contents"
      onKeyDown={(event) => {
        if (setup === null || event.key !== "Escape") return;
        event.stopPropagation();
        closeSetup();
      }}
    >
      {setup === null ? (
        <NetworkList onDone={onDone} />
      ) : (
        // Keyed so opening a second network starts its form from scratch rather
        // than inheriting the last one's draft.
        <Form key={setup.network ?? "new"} network={setup.network} onDone={closeSetup} />
      )}
    </div>
  );
}

function Form({ network, onDone }: { network: string | null; onDone: () => void }) {
  const [start, setStart] = useState<OnboardingStart | null>(
    network === null ? { step: "server", draft: emptyDraft() } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<NetworkConfig[]>([]);
  useAnnounce(error);

  useEffect(() => {
    let live = true;
    void ipc.listNetworkConfigs().then(
      (configs) => {
        if (!live) return;
        setIdentities(configs.filter((config) => config.id !== network));
        if (network === null) return;
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

  if (error !== null) {
    return (
      <p role="alert" className="px-8 py-6 text-[var(--danger)]">
        {error}
      </p>
    );
  }
  if (start === null) {
    return <p className="px-8 py-6 text-[var(--text-muted)]">Reading the saved settings…</p>;
  }
  // `start` is what makes Back leave the flow rather than fall through to the
  // chooser, and leaving the flow here is returning to the list.
  return <Onboarding onDone={onDone} start={start} identities={identities} />;
}
