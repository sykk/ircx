import { useState } from "react";
import type { Channel, Network, Topic } from "@/types";
import { CopyIcon } from "./icons";
import { describeModes } from "./modes";

interface ChannelInfoTabProps {
  channel: Channel;
  network: Network | undefined;
}

export function ChannelInfoTab({ channel, network }: ChannelInfoTabProps) {
  const modes = describeModes(channel.modes);
  const link = inviteLink(channel.name, network);
  const topic = channel.topic !== null && channel.topic.text !== "" ? channel.topic : null;
  const setNote = topic === null ? null : attribution(topic);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <section>
        <Heading>Topic</Heading>
        {topic === null ? (
          <p className="text-[var(--text-muted)]">No topic set</p>
        ) : (
          <>
            <p className="selectable text-[var(--text-primary)]">{topic.text}</p>
            {setNote !== null && (
              <p className="pt-1 text-[var(--text-muted)]" title={topic.setAt ?? undefined}>
                {setNote}
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <Heading>Modes</Heading>
        {modes.length === 0 ? (
          <p className="text-[var(--text-muted)]">None set</p>
        ) : (
          <>
            <p className="text-[var(--text-primary)]">{modes.join(", ")}</p>
            <p className="font-mono text-[var(--text-muted)]">{channel.modes}</p>
          </>
        )}
      </section>

      {link !== null && (
        <section>
          <Heading>Invite link</Heading>
          <div className="flex items-center gap-2">
            <code className="selectable min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
              {link}
            </code>
            <CopyButton value={link} />
          </div>
        </section>
      )}
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="pb-1 text-[11px] tracking-wide text-[var(--text-muted)] uppercase">
      {children}
    </h3>
  );
}

function attribution(topic: Topic): string | null {
  const when = topic.setAt === null ? null : relativeTime(topic.setAt);
  if (topic.setBy === null) return when === null ? null : `Set ${when}`;
  return when === null ? `Set by ${topic.setBy}` : `Set by ${topic.setBy} ${when}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy invite link"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {copied ? <span className="text-[var(--success)]">Copied</span> : <CopyIcon />}
    </button>
  );
}

/** The channel as a URL another client can open. The mockup shows an https
 * invite page; nothing serves one, so this is the address the server actually
 * answers on. */
function inviteLink(channel: string, network: Network | undefined): string | null {
  if (!network) return null;
  return `${network.tls ? "ircs" : "irc"}://${network.host}:${network.port}/${channel}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

function relativeTime(iso: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return RELATIVE.format(Math.round(seconds), "second");
}
