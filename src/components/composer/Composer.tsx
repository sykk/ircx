import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatMessage, CommandOutcome } from "@/types";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { Icon } from "@/components/common/Icon";
import { chooseFiles, ipc, reasonOr } from "@/lib/ipc";
import { nickColor } from "@/lib/nickColor";
import { useAnnounce } from "@/hooks/useAnnounce";
import { useAppStore } from "@/store";
import { targetKey, useMembers, useQueued, useReplyTarget, useView } from "@/store/selectors";
import { plainText } from "@/components/timeline/Markdown";
import type { ViewId } from "@/store/types";
import { CommandHint } from "./CommandHint";
import { matchCommands, runConnectionCommand } from "./commands";
import { cycleCompletion, startCompletion, type Completion } from "./completion";
import { useRecall } from "./recall";

const MAX_HEIGHT_PX = 180;
const DRAFT_DEBOUNCE_MS = 400;
/** The server-side indicator lasts several seconds; resending sooner is noise. */
const TYPING_INTERVAL_MS = 3_000;
const CHANNEL_PREFIX = /^[#&!+]/;

export function Composer({ view }: { view: ViewId | null }) {
  const pane = useView(view);
  if (!view || !pane || !pane.network) return null;
  const conversation = targetKey(pane.network, pane.target);
  return (
    <ComposerFor
      key={conversation}
      view={view}
      network={pane.network}
      target={pane.target}
    />
  );
}

function ComposerFor({
  view,
  network,
  target,
}: {
  view: ViewId;
  network: string;
  target: string;
}) {
  const members = useMembers(network, target);
  const replying = useReplyTarget(network, target);
  const recall = useRecall(network, target);
  const queued = useQueued(network, target);
  // What a reader needs from a draining queue is its two edges. The count
  // between them changes a hundred times in a paste and a polite region holds
  // every change it is given, so a region carrying the count would still be
  // reading numbers out after the last line had gone.
  //
  // The end is nothing left, not the one line the row below stops counting at:
  // "all sent" with one still in flight would be wrong at the only moment it is
  // worth saying. And it is held rather than derived, because the sentence is
  // only true of a queue that existed — with nothing to compare against, a
  // single line leaving would announce the end of a queue that never formed.
  const [saidBefore, setSaidBefore] = useState("");
  const queueSaid =
    queued > 1 ? "Messages waiting to send" : queued === 0 && saidBefore ? "All sent" : saidBefore;
  if (queueSaid !== saidBefore) setSaidBefore(queueSaid);
  useAnnounce(queueSaid);
  const [value, setValue] = useState("");
  // In the store rather than here, keyed by the pane: a change to the layout's
  // shape rebuilds every pane in the window (#308), and the line comes back
  // through the draft while the reason for its refusal would not.
  const error = useAppStore((s) => s.composerError[view] ?? null);
  useAnnounce(error);
  const setError = useCallback(
    (reason: string | null) => useAppStore.getState().setComposerError(view, reason),
    [view],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completionRef = useRef<Completion | null>(null);
  const caretRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const typingSentAt = useRef(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiAnchor = useRef<HTMLButtonElement>(null);
  /** Where the next picked emoji goes while the picker stays open. The textarea
   * loses focus on each click, so its selection cannot be trusted between picks. */
  const emojiCaretRef = useRef<number | null>(null);

  // A line being looked at is not a draft. While one is in the box the draft
  // stays what was typed before it, so stepping back through the history and
  // then leaving the conversation does not throw that away.
  const draft = recall.pending ?? value;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const candidates = useMemo(() => {
    const nicks = members.map((m) => m.nick);
    if (!CHANNEL_PREFIX.test(target) && !nicks.includes(target)) nicks.unshift(target);
    return nicks;
  }, [members, target]);

  // Saving before the stored draft has arrived would overwrite it with the
  // empty box, so every write waits on this.
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void ipc
      .getDraft(network, target)
      .then((stored) => {
        if (cancelled || !stored) return;
        setValue((current) => (current === "" ? stored : current));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (cancelled) return;
        hydratedRef.current = true;
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
    // `setError` writes to the store rather than to component state, so it is
    // a declared dependency where React's own setter needed none. It changes
    // only with the pane, which does not change under a mounted composer.
  }, [network, target, setError]);

  useEffect(() => {
    if (!hydrated) return;
    useAppStore.getState().setDraftPresence(network, target, draft !== "");
  }, [draft, hydrated, network, target]);

  useEffect(() => {
    if (!hydrated) return;
    const id = setTimeout(() => void ipc.setDraft(network, target, draft), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [hydrated, network, target, draft]);

  // The debounce above is cancelled by the unmount that a target switch causes,
  // so the last keystrokes only survive if they are flushed here.
  useEffect(() => {
    return () => {
      if (hydratedRef.current) void ipc.setDraft(network, target, draftRef.current);
      if (typingSentAt.current !== 0) void ipc.setTyping(network, target, false);
    };
  }, [network, target]);

  // A reply is armed from the timeline, where the control is a button: a
  // pointer leaves the focus on it, and what the reader types next goes to a
  // button and is lost. The caret follows the reply that was just armed, and
  // only that one — a reply still armed from before this composer mounted would
  // take the focus off whatever the reader has come back to.
  const armed = replying?.msgid ?? null;
  const armedBefore = useRef(armed);
  useEffect(() => {
    if (armed !== null && armed !== armedBefore.current) textareaRef.current?.focus();
    armedBefore.current = armed;
  }, [armed]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (caretRef.current !== null) {
      el.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    }
  }, [value]);

  const stopTyping = useCallback(() => {
    if (typingSentAt.current === 0) return;
    typingSentAt.current = 0;
    void ipc.setTyping(network, target, false);
  }, [network, target]);

  const onChange = (next: string) => {
    setValue(next);
    completionRef.current = null;
    // Once a recalled line is edited it is being typed, and is the draft.
    recall.reset();
    if (next === "") {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - typingSentAt.current >= TYPING_INTERVAL_MS) {
      typingSentAt.current = now;
      void ipc.setTyping(network, target, true);
    }
  };

  const insertEmoji = (emoji: string) => {
    setValue((current) => {
      const start = emojiCaretRef.current ?? current.length;
      const next = current.slice(0, start) + emoji + current.slice(start);
      const caret = start + emoji.length;
      emojiCaretRef.current = caret;
      caretRef.current = caret;
      return next;
    });
    completionRef.current = null;
    recall.reset();
    const now = Date.now();
    if (now - typingSentAt.current >= TYPING_INTERVAL_MS) {
      typingSentAt.current = now;
      void ipc.setTyping(network, target, true);
    }
  };

  /** Picked files go to the confirmation a drop gets, which is mounted with the
   * app and reads the focused pane. Pressing this button focused this pane, so
   * what was picked is offered to the conversation it was picked from.
   *
   * Files only: a folder is not something the upload can send, and the picker
   * offers one or the other rather than both. */
  const attach = async () => {
    let picked: string[] | null;
    try {
      picked = await chooseFiles(`Choose files to send to ${target}`);
    } catch (reason) {
      setError(reasonOr(reason, "The file picker could not be opened."));
      return;
    }
    if (picked === null) return;
    useAppStore.getState().setUploadRequest(picked);
  };

  const toggleEmojiPicker = () => {
    setEmojiOpen((open) => {
      if (open) return false;
      const el = textareaRef.current;
      emojiCaretRef.current = el?.selectionStart ?? value.length;
      return true;
    });
  };

  /** Draw the reason and give the line back, but only into an empty box: the
   * user may have started the next message while the round trip was in flight. */
  const refuse = (reason: string, text: string) => {
    setError(reason);
    setValue((current) => (current === "" ? text : current));
  };

  const send = async () => {
    const text = value.trim();
    if (text === "") return;
    setValue("");
    setError(null);
    completionRef.current = null;
    stopTyping();
    // Everything submitted is recallable, refusals included: a line the server
    // would not take is exactly one worth getting back to fix.
    recall.remember(text);
    void ipc.setDraft(network, target, "");

    // A command about the connection is performed here rather than sent: there
    // may be no session to send it to, which is the whole of why /connect
    // exists.
    try {
      if (await runConnectionCommand(text, network)) return;
    } catch (reason) {
      setError(String(reason));
      return;
    }

    // A refusal reaches here two ways. The server would not take the line, and
    // core answers `rejected`; or the command never got as far as the session,
    // and `App::ask` rejects the promise — the network is gone, or it stopped
    // answering inside its reply timeout. Both already carry a sentence written
    // for a reader, and both cost the same message if it is not shown.
    let outcome: CommandOutcome;
    try {
      outcome = await ipc.submitInput(network, target, text, replying?.msgid);
    } catch (reason) {
      refuse(String(reason), text);
      return;
    }
    // Core hands the local copy of a sent line back to the caller instead of
    // emitting it, so nothing else will draw it. A server with `echo-message`
    // confirms it later as an update to this same id; one without it never
    // says anything more, and this stays the only copy.
    if (outcome.kind === "sent") {
      // Only a line that was said consumes the reply. A `/join` typed with one
      // staged said nothing, so the parent is still waiting to be answered.
      useAppStore.getState().setReplyTo(network, target, null);
      const message = outcome.value;
      useAppStore.getState().applyEvent({
        type: "messagesAppended",
        network: message.network,
        target: message.target,
        messages: [message],
        answers: null,
      });
      return;
    }
    if (outcome.kind !== "rejected") return;
    refuse(outcome.value, text);
  };

  const complete = (el: HTMLTextAreaElement) => {
    const commands = matchCommands(el.value);
    if (commands) {
      const completed = `/${commands[0]!.name} `;
      caretRef.current = completed.length;
      setValue(completed);
      return;
    }

    const previous = completionRef.current;
    const stale =
      !previous || previous.text !== el.value || previous.caret !== el.selectionStart;
    const next = stale
      ? startCompletion(el.value, el.selectionStart ?? 0, candidates)
      : cycleCompletion(previous);
    if (!next) return;

    completionRef.current = next;
    caretRef.current = next.caret;
    setValue(next.text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME composition is open, every key belongs to it: the Enter
    // that commits a candidate must not send the half-composed line, and
    // Tab and the arrows are the IME's to navigate its candidate list with.
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      complete(e.currentTarget);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const el = e.currentTarget;
      const up = e.key === "ArrowUp";
      // Starting a recall replaces the whole box, so it takes a caret already
      // at the very edge of the text. Testing the caret rather than counting
      // newlines is what makes a long line that wraps behave: it has several
      // rows on screen and no newline in it, and the arrow has to walk through
      // them the way the reader means it to.
      //
      // Once a line has been recalled the box holds history rather than
      // anything typed, so stepping on through it needs no such caret: the
      // first edit ends the recall and the guard applies again.
      const caret = el.selectionStart ?? 0;
      const atEdge =
        caret === (el.selectionEnd ?? caret) &&
        (up ? caret === 0 : caret === el.value.length);
      if (recall.pending === null && !atEdge) return;

      const line = up ? recall.older(el.value) : recall.newer();
      if (line === null) return;
      e.preventDefault();
      completionRef.current = null;
      caretRef.current = line.length;
      setValue(line);
      return;
    }
    if (e.key === "Escape") {
      completionRef.current = null;
      setError(null);
      useAppStore.getState().setReplyTo(network, target, null);
    }
  };

  const hints = matchCommands(value);

  return (
    <div className="relative px-3 pb-2" data-ui="composer">
      {hints && <CommandHint commands={hints} />}

      {replying && (
        <ReplyBar
          parent={replying.parent}
          msgid={replying.msgid}
          onClear={() => useAppStore.getState().setReplyTo(network, target, null)}
        />
      )}

      {/* A live region, the way the console's identical control is one: the
          refusal is drawn in colour and position, and neither reaches a reader
          who cannot see it. Announced rather than merely labelled, because it
          answers a question the user has already asked by pressing Enter. */}
      {error && (
        <div
          role="alert"
          className="px-1 pb-1 text-[11px]"
          style={{ color: "var(--danger)" }}
        >
          {error}
        </div>
      )}

      <div role="status" className="sr-only">
        {queueSaid}
      </div>

      <div
        className="composer-field flex items-end gap-2 rounded-[var(--radius-md)] border px-3 py-2 transition-[box-shadow]"
        style={{ background: "var(--surface-raised)", borderColor: "var(--border-default)" }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          spellCheck
          placeholder={`Message ${target}`}
          aria-label={`Message ${target}`}
          className="selectable flex-1 resize-none bg-transparent text-[13px] leading-[1.5] outline-none"
          style={{ color: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => void attach()}
          aria-label="Attach files"
          // Flex rather than the emoji button's line box: an inline SVG sits on
          // the baseline and would hang the icon a descender below its
          // neighbour.
          className="mb-0.5 inline-flex shrink-0 items-center rounded-[var(--radius-sm)] px-1 py-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Icon name="paperclip" size={16} />
        </button>
        <span
          className="relative shrink-0 pb-0.5"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setEmojiOpen(false);
          }}
        >
          <button
            ref={emojiAnchor}
            type="button"
            aria-expanded={emojiOpen}
            aria-label="Insert emoji"
            onClick={toggleEmojiPicker}
            className="rounded-[var(--radius-sm)] px-1 py-0.5 text-[16px] leading-none hover:bg-[var(--surface-hover)]"
          >
            <span aria-hidden="true">😀</span>
          </button>
          {emojiOpen && (
            <span className="absolute bottom-full right-0 z-10 mb-1 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]">
              <EmojiPicker onPick={insertEmoji} />
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => void send()}
          disabled={value.trim() === ""}
          aria-label="Send"
          className="shrink-0 pb-0.5 text-[14px] disabled:opacity-[var(--disabled-opacity)]"
          style={{ color: "var(--accent)" }}
        >
          ➤
        </button>
      </div>

    </div>
  );
}

/**
 * What the next line will answer, over the box that will say it. Drawn with the
 * same connector as a `ReplyQuote` in the timeline, so the thing being staged
 * looks like the thing it becomes.
 */
function ReplyBar({
  parent,
  msgid,
  onClear,
}: {
  parent: ChatMessage | undefined;
  msgid: string;
  onClear: () => void;
}) {
  const nickColors = useAppStore((s) => s.presentation.nickColors);

  return (
    <div
      className="mb-1 flex items-baseline gap-2 overflow-hidden pl-2 font-[family-name:var(--font-ui)] text-[12px]"
      style={{
        borderLeft: "var(--timeline-quote-width) solid var(--border-strong)",
        color: "var(--text-faint)",
      }}
    >
      <span className="shrink-0">Replying to</span>
      {parent ? (
        <>
          <span
            className="shrink-0 font-[family-name:var(--font-mono)] font-semibold"
            style={{ color: nickColors ? nickColor(parent.sender.nick) : "var(--text-primary)" }}
          >
            {parent.sender.nick}
          </span>
          <span className="truncate">{plainText(parent.text)}</span>
        </>
      ) : (
        // Scrolled out of the loaded window. The msgid still names it on the
        // wire, so the reply is not cancelled by having nothing to quote.
        <span className="truncate">{msgid}</span>
      )}
      <button
        type="button"
        onClick={onClear}
        aria-label="Cancel reply"
        className="ml-auto shrink-0 px-1"
        style={{ color: "var(--text-muted)" }}
      >
        ✕
      </button>
    </div>
  );
}
