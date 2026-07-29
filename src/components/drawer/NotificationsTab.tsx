import type { TargetKey } from "@/store/keys";
import { NOTIFY_LEVELS, useChannelPrefs } from "./channelPrefs";

interface NotificationsTabProps {
  channelKey: TargetKey;
  channelName: string;
}

export function NotificationsTab({ channelKey, channelName }: NotificationsTabProps) {
  const [prefs, update] = useChannelPrefs(channelKey);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <fieldset>
        <legend className="pb-2 text-[11px] tracking-wide text-[var(--text-muted)] uppercase">
          Notify me about {channelName}
        </legend>
        {NOTIFY_LEVELS.map((level) => (
          <label
            key={level.value}
            className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--surface-hover)]"
          >
            <input
              type="radio"
              name="notify-level"
              value={level.value}
              checked={prefs.notify === level.value}
              onChange={() => update({ notify: level.value })}
              className="mt-1 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-[var(--text-primary)]">{level.label}</span>
              <span className="block text-[var(--text-muted)]">{level.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
