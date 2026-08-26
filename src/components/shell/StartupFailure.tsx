import { PrimaryButton } from "@/components/onboarding/fields";

/**
 * What the window says when it could not read its own data.
 *
 * It used to say nothing. `App` caught the failure, wrote a line to a console
 * no user has, and set the startup state to ready — so a locked archive drew
 * the same empty client as one with nothing in it yet, and the only difference
 * from a fresh install was that this one did not offer onboarding.
 *
 * The reason is shown rather than summarised. Every Tauri command in this
 * client answers with a sentence written for a person, so the backend has
 * already said the useful thing and repeating it in worse words would lose it.
 */
export function StartupFailure({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-ui="startup-failure"
      className="flex h-full min-h-0 items-center justify-center p-6"
    >
      <div className="flex max-w-[32rem] flex-col gap-3">
        <h1 className="text-[15px] font-medium text-[var(--text-primary)]">
          ircx could not read its own data
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)]">{reason}</p>
        <p className="text-[12px] text-[var(--text-muted)]">
          Nothing has been lost: your networks and message history are files on this computer,
          and this window could not open them. Trying again is safe. If it keeps failing, quit
          ircx and start it again.
        </p>
        <div>
          <PrimaryButton type="button" onClick={onRetry}>
            Try again
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
