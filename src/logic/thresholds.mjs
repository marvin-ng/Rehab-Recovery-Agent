// Phase 3 deterministic-logic tunables. Every magic number the logic layer
// depends on lives here and nowhere else, so tuning later means editing one
// file. No AWS, no clock, no model — pure constants.

// Adherence
// Nudge once it has been this many whole days since the last logged session.
export const ADHERENCE_NUDGE_DAYS = 2;
// The prescribed 3–4x/week target; "on target" is met at this count or above.
export const ADHERENCE_WEEKLY_TARGET = 3;

// Asymmetry
// Need at least this many moderate+ instances on a side before we'll judge it;
// below this on both sides we report insufficient_data rather than guess.
export const ASYMMETRY_MIN_SAMPLE = 3;
// Flag a side only when its moderate+ count exceeds the other's by this much.
export const ASYMMETRY_FLAG_DIFFERENTIAL = 2;
// Look-back window (days) over which asymmetry instances are counted.
export const ASYMMETRY_WINDOW_DAYS = 30;

// Trend
// Each trend window (days). Recent window vs the equal window before it.
export const TREND_WINDOW_DAYS = 14;
// Minimum average-rating shift between the two windows to call a direction;
// smaller shifts read as plateauing.
export const TREND_SIGNIFICANT_SHIFT = 1;
