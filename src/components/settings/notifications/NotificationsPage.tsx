import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/common/Icon";
import {
  CheckField,
  Group,
  Note,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "@/components/onboarding/fields";
import { SettingsPage, useReportBusy } from "@/components/settings/SettingsPage";
import { useAnnounce } from "@/hooks/useAnnounce";
import { loadHighlightWords } from "@/lib/highlights";
import {
  allowedToNotify,
  storeNotifications,
  storedNotifications,
  type Notifications,
} from "@/lib/notifications";
import { ipc, reasonOr } from "@/lib/ipc";
import type { SettingsScope } from "@/components/settings/scope";
import type { IgnoredPerson, MutedConversation } from "@/types";

/**
 * What is allowed to interrupt the reader: the words that raise a conversation,
 * and the conversations that may not.
 *
 * What a match then does — a desktop notification, a sound — is the rest of the
 * section, and `docs/notifications.md` argues its shape.
 *
 * Both lists are read here rather than out of the store, because this window
 * runs no event bridge and nothing has primed one for it. They are the
 * backend's anyway: the badge is counted there, against the same words and the
 * same mutes.
 */
export function NotificationsPage({
  here,
  onDone,
}: {
  /** The conversation this page is scoped to, or null — see
   * `src/components/settings/scope.ts`. */
  here: SettingsScope | null;
  onDone: () => void;
}) {
  const [words, setWords] = useState<string[] | null>(null);
  const [muted, setMuted] = useState<MutedConversation[]>([]);
  const [ignored, setIgnored] = useState<IgnoredPerson[]>([]);
  const [notify, setNotify] = useState<Notifications>(storedNotifications);
  const [refused, setRefused] = useState(false);
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

  const readMuted = useCallback(() => {
    void ipc.mutedConversations().then(
      (held) => setMuted(held),
      (reason: unknown) =>
        setError(reasonOr(reason, "What you have muted could not be read.")),
    );
  }, []);

  useEffect(readMuted, [readMuted]);

  const readIgnored = useCallback(() => {
    void ipc.ignoredPeople().then(
      (held) => setIgnored(held),
      (reason: unknown) =>
        setError(reasonOr(reason, "Who you have ignored could not be read.")),
    );
  }, []);

  useEffect(readIgnored, [readIgnored]);

  /* Only ever the undo: an ignore is started where the person is, which is the
     roster and the composer. This window has no list of who is on a network to
     start one from. */
  const hear = useCallback(
    async (network: string, nick: string) => {
      report(true);
      try {
        await ipc.setIgnored(network, nick, false);
        setError(null);
        readIgnored();
      } catch (reason) {
        setError(reasonOr(reason, "That could not be changed."));
      }
      report(false);
    },
    [readIgnored, report],
  );

  /**
   * Turns a notification switch on or off.
   *
   * The desktop is asked for permission when a switch goes on rather than at
   * startup: the prompt is about something the reader has just asked for. A
   * refusal leaves the switch off and says so, because the alternative is a
   * setting that reads as on and does nothing.
   */
  const choose = useCallback(async (next: Notifications) => {
    const turningOn =
      (next.highlights && !storedNotifications().highlights) ||
      (next.directMessages && !storedNotifications().directMessages);
    if (turningOn && !(await allowedToNotify())) {
      setRefused(true);
      return;
    }
    setRefused(false);
    setNotify(next);
    storeNotifications(next);
  }, []);

  /**
   * Mutes or unmutes one conversation, or a whole network for a null target.
   *
   * The list is re-read rather than patched: the network's name comes back
   * with each row, and this page has no network list of its own to make one
   * out of a row it invented.
   */
  const mute = useCallback(
    async (network: string, target: string | null, next: boolean) => {
      report(true);
      try {
        await ipc.setMuted(network, target, next);
        setError(null);
        readMuted();
      } catch (reason) {
        setError(reasonOr(reason, "That could not be muted."));
      } finally {
        report(false);
      }
    },
    [readMuted, report],
  );

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
        await loadHighlightWords();
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

      <Group title="What interrupts you">
        <CheckField
          label="Notify me about highlights"
          hint="Your nickname, or one of the words above, in a channel."
          checked={notify.highlights}
          onChange={(highlights) => void choose({ ...notify, highlights })}
        />
        <CheckField
          label="Notify me about direct messages"
          hint="Any line in a query. Somebody opened a conversation with you and nobody else, so there is no word to match."
          checked={notify.directMessages}
          onChange={(directMessages) => void choose({ ...notify, directMessages })}
        />
        <Note>
          Nothing arrives for the conversation you are looking at. Clicking a notification does
          not open it — the desktop does not tell ircx it was clicked — so it names the
          conversation instead.
        </Note>
        {refused && (
          <Note error>
            Your desktop refused notifications for ircx. Allow them in its settings and try again.
          </Note>
        )}
      </Group>

      <Group title="Muted conversations">
        {here === null ? (
          <Note>
            Open this from a conversation to mute it. Muting is offered where you are, because
            this window has no list of what is open.
          </Note>
        ) : (
          <>
            {here.target !== null && (
              <CheckField
                label={`Mute ${here.target}`}
                hint="No desktop notification, and the badge stays quiet even for your own nickname. The count beside it still rises."
                checked={isMuted(muted, here.network, here.target)}
                onChange={(next) => void mute(here.network, here.target, next)}
              />
            )}
            <CheckField
              label={`Mute everything on ${here.networkName}`}
              hint="Every conversation on this network, including ones you have not opened yet."
              checked={isMuted(muted, here.network, null)}
              onChange={(next) => void mute(here.network, null, next)}
            />
          </>
        )}

        {muted.length > 0 && (
          <ul className="flex flex-col gap-1">
            {muted.map((row) => (
              <li
                key={`${row.network}\u0000${row.target}`}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--surface-hover)]"
              >
                <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
                  {row.target === "" ? (
                    <>Everything on {row.networkName}</>
                  ) : (
                    <>
                      <span className="font-[family-name:var(--font-mono)]">{row.target}</span>
                      <span className="text-[var(--text-muted)]"> on {row.networkName}</span>
                    </>
                  )}
                </span>
                <SecondaryButton
                  onClick={() =>
                    void mute(row.network, row.target === "" ? null : row.target, false)
                  }
                >
                  Unmute
                </SecondaryButton>
              </li>
            ))}
          </ul>
        )}

        <Note>
          A rule still writes down what it thought was worth reading in a muted conversation, and
          the message still says so. What mute takes away is the interruption.
        </Note>
      </Group>

      <Group title="Ignored people">
        {ignored.length === 0 ? (
          <Note>
            Nobody is ignored. Start one from the member list, or with{" "}
            <code>/ignore nickname</code> in a conversation.
          </Note>
        ) : (
          <ul className="flex flex-col gap-1">
            {ignored.map((row) => (
              <li
                key={`${row.network}\u0000${row.nick}`}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--surface-hover)]"
              >
                <span className="min-w-0 truncate text-[13px] text-[var(--text-primary)]">
                  <span className="font-[family-name:var(--font-mono)]">{row.nick}</span>
                  <span className="text-[var(--text-muted)]"> on {row.networkName}</span>
                </span>
                <SecondaryButton onClick={() => void hear(row.network, row.nick)}>
                  Stop ignoring
                </SecondaryButton>
              </li>
            ))}
          </ul>
        )}

        <Note>
          Stronger than a mute, and the difference is what is kept: a muted conversation is all
          still there to scroll back through, while nothing an ignored person says is written down
          at all. Hearing from them again starts from that moment — what they said meanwhile does
          not come back.
        </Note>
      </Group>
    </SettingsPage>
  );
}

/** Whether this conversation is muted, or the network it is on. A null target
 * asks about the network itself. */
function isMuted(muted: MutedConversation[], network: string, target: string | null): boolean {
  return muted.some(
    (row) =>
      row.network === network &&
      (target === null
        ? row.target === ""
        : row.target.toLowerCase() === target.toLowerCase()),
  );
}

const blurb = "What is worth interrupting you for, beside your own nickname.";
