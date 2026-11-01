/** Clock label for a live balance read. Empty when the timestamp cannot be parsed. */
export function liveReadStamp(iso: string): string {
  const then = Date.parse(iso);
  if (!iso || Number.isNaN(then)) return "";
  const date = new Date(then);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `live, read at ${hours}:${minutes} UTC`;
}

/** Relative label for a source timestamp. Empty when the timestamp cannot be parsed. */
export function updatedAgo(asOf: string, nowMs: number): string {
  const then = Date.parse(asOf);
  if (!asOf || Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 45) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `updated ${days} day${days === 1 ? "" : "s"} ago`;
}
