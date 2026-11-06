/* When this browser last exported all of Notes' data, and whether it is
   time to again: while the data lives in the browser alone, an export is
   the copy that survives the browser clearing it. */

const LAST_EXPORT = "notes:lastExport";
const OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

/** When the last export was made, or null for never. */
export function lastExport(): Date | null {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LAST_EXPORT);
  } catch {
    return null;
  }
  if (!stored) return null;
  const at = new Date(stored);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function markExported(at = new Date()): void {
  try {
    localStorage.setItem(LAST_EXPORT, at.toISOString());
  } catch {
    // Nothing kept: the reminder stays on.
  }
}

/** Whether to remind: never exported, or not for seven days. */
export function exportOverdue(now = Date.now()): boolean {
  const at = lastExport();
  return !at || now - at.getTime() > OVERDUE_MS;
}

/** The file an export downloads as: `weave-backup-YYYY-MM-DD.json`. */
export function backupFileName(at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `weave-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}

/** How long a download's address is kept: a browser may still be reading
 *  the bytes after the click returns, and letting go at once can cancel a
 *  large download (Firefox, Safari). */
const DOWNLOAD_HOLD_MS = 60_000;

/** Saves `blob` as `name` through the browser's own download. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_HOLD_MS);
}
