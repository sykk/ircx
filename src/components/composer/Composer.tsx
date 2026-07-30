import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ipc } from "@/lib/ipc";
import { targetKey, useActiveTarget, useMembers } from "@/store/selectors";
import { CommandHint } from "./CommandHint";
import { matchCommands } from "./commands";
import { cycleCompletion, startCompletion, type Completion } from "./completion";

const MAX_HEIGHT_PX = 180;
const DRAFT_DEBOUNCE_MS = 400;
/** The server-side indicator lasts several seconds; resending sooner is noise. */
const TYPING_INTERVAL_MS = 3_000;
const CHANNEL_PREFIX = /^[#&!+]/;

export function Composer() {
  const active = useActiveTarget();
  if (!active) return null;
  const conversation = targetKey(active.network, active.target);
  return <ComposerFor key={conversation} network={active.network} target={active.target} />;
}

function ComposerFor({ network, target }: { network: string; target: string }) {
  const members = useMembers(network, target);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completionRef = useRef<Completion | null>(null);
  const caretRef = useRef<number | null>(null);
  const valueRef = useRef("");
  const typingSentAt = useRef(0);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

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
      .then((draft) => {
        if (cancelled || !draft) return;
        setValue((current) => (current === "" ? draft : current));
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
  }, [network, target]);

  useEffect(() => {
    if (!hydrated) return;
    const id = setTimeout(() => void ipc.setDraft(network, target, value), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [hydrated, network, target, value]);

  // The debounce above is cancelled by the unmount that a target switch causes,
  // so the last keystrokes only survive if they are flushed here.
  useEffect(() => {
    return () => {
      if (hydratedRef.current) void ipc.setDraft(network, target, valueRef.current);
      if (typingSentAt.current !== 0) void ipc.setTyping(network, target, false);
    };
  }, [network, target]);

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

  const send = async () => {
    const text = value.trim();
    if (text === "") return;
    setValue("");
    setError(null);
    completionRef.current = null;
    stopTyping();
    void ipc.setDraft(network, target, "");

    const outcome = await ipc.submitInput(network, target, text);
    if (outcome.kind !== "rejected") return;
    setError(outcome.value);
    // Restoring only into an empty box: the user may have started the next
    // message while the round trip was in flight.
    setValue((current) => (current === "" ? text : current));
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
    if (e.key === "Escape") {
      completionRef.current = null;
      setError(null);
    }
  };

  const hints = matchCommands(value);

  return (
    <div className="relative px-3 pb-2">
      {hints && <CommandHint commands={hints} />}

      {error && (
        <div className="px-1 pb-1 text-[11px]" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      <div
        className="flex items-end gap-2 rounded-[var(--radius-lg)] border px-3 py-2"
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
          onClick={() => void send()}
          disabled={value.trim() === ""}
          aria-label="Send"
          className="shrink-0 pb-0.5 text-[14px] disabled:opacity-40"
          style={{ color: "var(--accent)" }}
        >
          ➤
        </button>
      </div>

      <div
        className="flex justify-between px-1 pt-1 text-[11px]"
        style={{ color: "var(--text-faint)" }}
      >
        <span>Markdown is supported</span>
        <span>Shift+Enter for new line</span>
      </div>
    </div>
  );
}
