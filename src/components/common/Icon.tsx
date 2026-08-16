const PATHS = {
  lock: "M4.25 7.25h7.5v5.5h-7.5zM6 7.25V5.25a2 2 0 0 1 4 0v2",
  minimize: "M3.5 8h9",
  maximize: "M3.5 3.5h9v9h-9z",
  restore: "M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7z",
  close: "m4 4 8 8M12 4l-8 8",
  sidebar: "M2.5 3h11v10h-11zM6.5 3v10",
  plus: "M8 3.75v8.5M3.75 8h8.5",
  check: "m3.5 8.4 3.1 3.1 5.9-6.9",
  external: "M12.5 9.5v3h-9v-9h3M9.5 3.5h3v3M12.5 3.5 7.5 8.5",
  // The mark the timeline already puts in front of an attachment, so the button
  // that makes one and the line it becomes carry the same glyph.
  paperclip: "M11.5 6.5 6.75 11.25a2 2 0 0 1-2.83-2.83l5.4-5.4a3 3 0 0 1 4.24 4.24l-5.4 5.4",
  draft: "M3 13l.7-3.1L10.9 2.7l2.4 2.4-7.2 7.2zM9.8 3.8l2.4 2.4",
  // A hub and eight spokes. A gear's teeth do not survive being drawn at 14px
  // in a 1.5px stroke — they close up into a grey ring — so the spokes carry
  // it. The hub is wide and the spokes short: the first draft had it the other
  // way round and read as a sun.
  settings:
    "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8M8 2.4v1.3M8 12.3v1.3M13.6 8h-1.3M3.7 8H2.4M11.95 4.05l-.92.92M4.97 11.03l-.92.92M11.95 11.95l-.92-.92M4.97 4.97l-.92-.92",
  // Appearance, as a drop of colour. The brush the concept drew reads as a
  // smudge at this size; a drop keeps its silhouette.
  droplet: "M8 2.4c2.4 2.6 3.9 4.6 3.9 6.4a3.9 3.9 0 0 1-7.8 0c0-1.8 1.5-3.8 3.9-6.4",
  // Privacy: what is kept about you, and for how long.
  shield: "M8 2.2 3.5 3.9v3.7c0 2.7 1.8 4.7 4.5 6.2 2.7-1.5 4.5-3.5 4.5-6.2V3.9z",
  // Notifications, as the bell. The dome carries it at this size; the clapper
  // under it is what keeps the silhouette from reading as an arch.
  bell: "M8 2.7a3.3 3.3 0 0 1 3.3 3.3v2.5l1 2.1H3.7l1-2.1V6A3.3 3.3 0 0 1 8 2.7M6.7 12.9a1.4 1.4 0 0 0 2.6 0",
  // A muted conversation, as the bell with the stroke every mute control has
  // drawn since the first one. The dome is clipped where the stroke crosses it
  // rather than drawn under it: at 12px an unbroken bell behind a line reads as
  // a bell with a scratch.
  bellOff:
    "M11.3 9.1V6a3.3 3.3 0 0 0-5-2.8M4.7 5.4V6v2.5l-1 2.1h6.6M6.7 12.9a1.4 1.4 0 0 0 2.6 0M3 3l10 10",
  // Plugins, as the plug rather than the puzzle piece: a jigsaw tab loses its
  // notch at 15px and reads as a rounded square.
  plug: "M6.2 2.3v3M9.8 2.3v3M4.4 5.3h7.2v2.4a3.6 3.6 0 0 1-7.2 0zM8 11.3v2.4",
  // Networks, as the globe: the servers this client dials are somewhere else.
  // Equator and meridian both — a bare circle at 15px is a bare circle.
  globe:
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M2.5 8h11M8 2.5c1.5 1.7 2.3 3.5 2.3 5.5S9.5 11.8 8 13.5C6.5 11.8 5.7 10 5.7 8S6.5 4.2 8 2.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
