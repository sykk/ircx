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

export function ClearIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m3 11 7.8-7.8 2 2L5 13H3z" />
      <path d="M7.8 6.2 9.8 8.2M8.5 13h4M10.5 10.8h2" />
    </svg>
  );
}

export function CatchUpIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 3h12L9.5 8v4l-3 1V8z" />
    </svg>
  );
}

export function WireIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.5 4.5 6.5 8l-3 3.5" />
      <path d="M8.5 11.5h4" />
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

export function ChevronIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
