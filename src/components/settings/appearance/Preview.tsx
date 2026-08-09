import { useMemo } from "react";
import { Icon } from "@/components/common/Icon";
import { renderRow } from "@/components/timeline/Timeline";
import { assignGroups } from "@/components/timeline/groups";
import { buildRows } from "@/components/timeline/rows";
import { nickColor } from "@/lib/nickColor";
import type { HighlightRule } from "@/store/selectors";
import {
  PREVIEW_MEMBERS,
  PREVIEW_OWN_NICK,
  PREVIEW_TARGET,
  PREVIEW_TOPIC,
  previewMessages,
} from "./previewChannel";

/**
 * A channel, drawn with every setting on this page as it now stands.
 *
 * The rows come from `buildRows` and `renderRow` — the client's own, the same
 * two functions the real timeline calls — because every one of these settings
 * is read out of the store by the components underneath: the spine by
 * `MessageBlock`, the clock by `Clock`, the name and its brackets by
 * `SenderPrefix`. Nothing here passes them down and nothing here has a copy of
 * them, so the preview cannot drift from the thing it is previewing. The
 * density, the palette and the two faces arrive by the other route, as tokens
 * on the root element, which is why this window paints itself with them too.
 *
 * What is drawn by hand is the chrome around the conversation: the header, the
 * roster and the composer. Those are store-bound to a real pane in the client,
 * and a preview does not have one.
 */
/** The nick the sample is written against, with no words beside it. */
const PREVIEW_HIGHLIGHT: HighlightRule = { nick: PREVIEW_OWN_NICK, words: [] };

export function Preview() {
  // Once per mount. The script is dated relative to today, and a preview whose
  // date rule changed under the reader at midnight would be a strange thing to
  // have built on purpose.
  const rows = useMemo(() => {
    const messages = previewMessages();
    const present = new Set(PREVIEW_MEMBERS.map((nick) => nick.toLowerCase()));
    const groups = assignGroups(messages, PREVIEW_MEMBERS);
    return buildRows(messages, null, PREVIEW_HIGHLIGHT, groups, present);
  }, []);

  const context = useMemo(
    () => ({
      ownNick: PREVIEW_OWN_NICK,
      // The nick and no words. The sample is a picture of how a conversation is
      // set, and a reader's own keywords would light up lines of it at random
      // depending on what they happened to have added.
      highlight: PREVIEW_HIGHLIGHT,
      parentOf: () => undefined,
      onJump: () => {},
      // No hover controls: a react button in a sample is a control that answers
      // to nothing, and this is a picture of a conversation rather than one.
      canTag: false,
      onReact: () => {},
      onReply: () => {},
      flashId: null,
      present: new Set(PREVIEW_MEMBERS.map((nick) => nick.toLowerCase())),
    }),
    [],
  );

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-base)]">
      <p className="sr-only">
        A sample conversation, drawn with the appearance settings on this page.
      </p>

      {/* Inert, not merely unclickable: the sample holds a channel name, a
          roster and a composer that lead nowhere, and leaving them in the tab
          order would put a dozen dead stops between the theme cards and the
          controls beside them. */}
      <div inert>
        <header className="flex items-baseline gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-mono)] text-[13px] font-semibold text-[var(--text-primary)]">
            {PREVIEW_TARGET}
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {PREVIEW_MEMBERS.length} members · {PREVIEW_TOPIC}
          </span>
        </header>

        <div className="flex min-h-0">
          <div className="min-w-0 flex-1">
            {/* Tall enough for the whole script at the middle density, which
                is what makes the sample worth its room: the declared group is
                the last thing in it and the one nothing else demonstrates. It
                scrolls at Read, which is the density saying what it means. */}
            <div className="h-[470px] overflow-y-auto px-3 py-2">
              {rows.map((row) => (
                <div key={row.id}>{renderRow(row, context)}</div>
              ))}
            </div>

            <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
              <span className="text-[var(--text-muted)]">
                <Icon name="plus" />
              </span>
              <span className="text-[12px] text-[var(--text-faint)]">
                Message {PREVIEW_TARGET}
              </span>
            </div>
          </div>

          <div className="w-[136px] shrink-0 overflow-y-auto border-l border-[var(--border-subtle)] px-3 py-2">
            <p className="pb-1.5 text-[11px] text-[var(--text-muted)]">
              Members {PREVIEW_MEMBERS.length}
            </p>
            <ul className="flex flex-col gap-0.5">
              {PREVIEW_MEMBERS.map((nick) => (
                <li
                  key={nick}
                  className="font-[family-name:var(--font-mono)] text-[12px]"
                  style={{ color: nickColor(nick) }}
                >
                  {nick}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
