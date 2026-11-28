export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Sub-second builds show milliseconds (e.g. `420ms`) so fast derivations do not read as `0s`. */
export function formatTiming(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded === 0) return "0s";
  if (rounded < 1_000) return `${rounded}ms`;
  return formatDuration(rounded);
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** `ssh-ng://builder@host` → `builder@host`, `https://cache.nixos.org` → `cache.nixos.org` */
export function formatPeer(uri: string): string {
  return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/$/, "");
}

/** Collapses whitespace, newlines included, so a multi-line `-E` expression fits on one row. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
