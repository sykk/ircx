interface IconProps {
  size?: number;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function MembersIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6" cy="6" r="2.4" />
      <path d="M1.5 13c0-2.1 2-3.3 4.5-3.3S10.5 10.9 10.5 13" />
      <path d="M11 4.2a2.2 2.2 0 0 1 0 4.1M12.2 9.9c1.5.4 2.3 1.5 2.3 3.1" />
    </svg>
  );
}

export function InviteIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13c0-2.2 2-3.5 4.5-3.5 .7 0 1.4.1 2 .3" />
      <path d="M12 8.5v5M9.5 11h5" />
    </svg>
  );
}

export function SearchIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 14 14" />
    </svg>
  );
}

export function PanelIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M10 3v10" />
    </svg>
  );
}
