import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/common/Icon";
import { Group, Note, PrimaryButton, TextField } from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { useAnnounce } from "@/hooks/useAnnounce";
import { announceHighlightWords } from "@/lib/highlights";
import { ipc, reasonOr } from "@/lib/ipc";

/**
 * What is allowed to interrupt the reader.
 *
 * The words only, for now. What a match does — a desktop notification, a
 * sound — and which conversations are exempt are the rest of the section, and
 * `docs/notifications.md` is where the shape of both is argued.
 *
 * The list is read here rather than out of the store, because this window runs
 * no event bridge and nothing has primed one for it. It is the backend's
 * anyway: the badge is counted there, against the same words.
 */
export function NotificationsPage({ onDone }: { onDone: () => void }) {
  const [words, setWords] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  useAnnounce(error);
  const report = useReportBusy();

  useEffect(() => {
    void ipc.highlightWords().then(
      (held) => setWords(held),
      (reason: unknown) =>
        setError(reasonOr(reason, "The words that raise a conversation could not be read.")),
    );
  }, []);

  /**
   * Writes the list and tells the client, which is drawing a conversation
   * against the old one until it hears.
   *
   * The screen is moved first and put back if the write fails. Every control
   * on every settings page commits as it is used, and a word that waits for a
   * round trip before appearing reads as a keystroke that was dropped.
   */
  const commit = useCallback(
    async (next: string[], before: string[]) => {
      setWords(next);
      report(true);
      try {
        await ipc.setHighlightWords(next);
        await announceHighlightWords();
        setError(null);
      } catch (reason) {
        setWords(before);
        setError(reasonOr(reason, "The words could not be saved."));
      } finally {
        report(false);
      }
    },
    [report],
  );

  if (words === null) {
    return (
      <SettingsPage title="Notifications" blurb={blurb} onDone={onDone}>
        {error !== null && <Note error>{error}</Note>}
      </SettingsPage>
    );
  }

  const listed = words;
  const word = typed.trim();
  // Caselessly, because the match is caseless: offering to add Deploy to a list
  // already holding deploy offers a word that would change nothing.
  const duplicate = listed.some((existing) => existing.toLowerCase() === word.toLowerCase());

  function add() {
    if (word === "" || duplicate) return;
    setTyped("");
    void commit([...listed, word], listed);
  }

  function remove(at: number) {
    void commit(
      listed.filter((_, index) => index !== at),
      listed,
    );
  }

  return (
    <SettingsPage title="Notifications" blurb={blurb} onDone={onDone}>
      <Group title="Words that raise a conversation">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="flex-1">
            <TextField
              label="Add a word"
              value={typed}
              onChange={setTyped}
              placeholder="deploy"
              error={duplicate ? `${word} is already on the list.` : null}
            />
          </div>
          <PrimaryButton type="submit" disabled={word === "" || duplicate}>
            Add
          </PrimaryButton>
        </form>

        {listed.length === 0 ? (
          <Note>
            Nothing yet. Your nickname raises a conversation on its own, and always will.
          </Note>
        ) : (
          <ul className="flex flex-col gap-1">
            {listed.map((held, at) => (
              <li
                key={held}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--surface-hover)]"
              >
                <span className="truncate font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-primary)]">
                  {held}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${held}`}
                  onClick={() => remove(at)}
                  className="shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Note>
          A word is matched the way your nickname is: whole, and whatever the case. Adding deploy
          finds &ldquo;Deploy failed&rdquo; and leaves &ldquo;redeployed&rdquo; alone.
        </Note>

        {error !== null && <Note error>{error}</Note>}
      </Group>
    </SettingsPage>
  );
}

const blurb = "What is worth interrupting you for, beside your own nickname.";
