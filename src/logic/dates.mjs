// Pure date helpers for the logic layer. Parse "YYYY-MM-DD" as UTC so day
// arithmetic is deterministic and timezone-free. No Date.now() / clock reads —
// every caller passes an explicit reference date.

const MS_PER_DAY = 86_400_000;

// Whole UTC days since the epoch for a "YYYY-MM-DD" string. Integer, so
// subtracting two of these gives an exact whole-day difference.
function toEpochDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

// Whole days from `dateStr` up to `asOfDateStr` (asOf - date). Positive = past,
// negative = after the reference date.
export function daysBefore(dateStr, asOfDateStr) {
  return toEpochDay(asOfDateStr) - toEpochDay(dateStr);
}

// True if `dateStr` falls in the trailing `windowDays` up to and including
// `asOfDateStr` (i.e. asOf - date is in [0, windowDays)). Future dates and dates
// older than the window are excluded.
export function withinTrailingWindow(dateStr, asOfDateStr, windowDays) {
  const diff = daysBefore(dateStr, asOfDateStr);
  return diff >= 0 && diff < windowDays;
}
