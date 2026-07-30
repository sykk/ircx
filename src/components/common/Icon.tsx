const PATHS = {
  lock: "M4.25 7.25h7.5v5.5h-7.5zM6 7.25V5.25a2 2 0 0 1 4 0v2",
  minimize: "M3.5 8h9",
  maximize: "M3.5 3.5h9v9h-9z",
  restore: "M5.5 5.5V3.5h7v7h-2M3.5 5.5h7v7h-7z",
  close: "m4 4 8 8M12 4l-8 8",
  sidebar: "M2.5 3h11v10h-11zM6.5 3v10",
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
