import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SQLite stores timestamps as `YYYY-MM-DD HH:MM:SS` with no timezone marker, so
// passing them straight to `new Date(...)` makes the browser read them as LOCAL
// time when they are actually UTC — shifting every displayed time by the
// viewer's offset. These helpers tag the value as UTC before parsing. (#170)

/** Convert a SQLite UTC datetime string into an ISO-8601 UTC string. */
export function sqliteUtcToIso(value: string): string {
  // Already ISO (has 'T' and a zone/offset)? Leave it alone.
  if (value.includes('T')) return value;
  return value.replace(' ', 'T') + 'Z';
}

/** Format a SQLite UTC datetime string as the viewer's local time-of-day. */
export function formatSqliteUtcToLocalTime(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' },
): string {
  if (!value) return '—';
  const date = new Date(sqliteUtcToIso(value));
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], options);
}

/** Format a SQLite UTC datetime string as relative time ago ("5分钟前"). */
export function formatTimeAgo(value: string | null | undefined): string {
  if (!value) return '从未探测';
  const date = new Date(sqliteUtcToIso(value));
  if (isNaN(date.getTime())) return '从未探测';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) return '刚刚';
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

