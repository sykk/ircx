/** Bytes as somebody would say them: two significant figures and a unit. */
export function formatBytes(bytes: bigint | number): string {
  const total = Number(bytes);
  if (total < 1024) return `${total} B`;
  const units = ["KB", "MB", "GB"];
  let size = total / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}
