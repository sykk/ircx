import type { TargetKey } from "@/store/keys";
import { RETENTION_CHOICES, useChannelPrefs, type RetentionChoice } from "./channelPrefs";

interface ChannelSettingsTabProps {
  channelKey: TargetKey;
  channelName: string;
}

export function ChannelSettingsTab({
  channelKey,
  channelName,
}: ChannelSettingsTabProps) {
  const [prefs, update] = useChannelPrefs(channelKey);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <label
        htmlFor="channel-retention"
        className="block pb-2 text-[11px] tracking-wide text-[var(--text-muted)] uppercase"
      >
        Local history for {channelName}
      </label>
      <select
        id="channel-retention"
        value={prefs.retention}
        onChange={(e) => update({ retention: e.target.value as RetentionChoice })}
        className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 py-1 text-[var(--text-primary)]"
      >
        {RETENTION_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <p className="pt-2 text-[var(--text-muted)]">
        Overrides how long the local archive keeps messages from this channel.
      </p>
    </div>
  );
}
