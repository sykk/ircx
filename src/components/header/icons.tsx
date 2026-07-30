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

export function SearchIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 14 14" />
    </svg>
  );
}

export function OverflowIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)} fill="currentColor" stroke="none">
      <circle cx="8" cy="3.4" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="8" cy="12.6" r="1.2" />
    </svg>
  );
}
