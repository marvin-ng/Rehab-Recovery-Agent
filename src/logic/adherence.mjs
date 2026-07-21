// Adherence tracking: missed-session nudge + weekly count against target.
// Pure functions — sessions are already-fetched plain items, asOfDate is an
// explicit "YYYY-MM-DD" reference. No AWS, no clock, no model.
import { daysBefore, withinTrailingWindow } from "./dates.mjs";
import { ADHERENCE_NUDGE_DAYS, ADHERENCE_WEEKLY_TARGET } from "./thresholds.mjs";

// A week is 7 calendar days by definition — the fixed span of the weekly
// window, not a tunable threshold, so it stays a literal here.
const WEEK_DAYS = 7;

// Most recent session date vs asOfDate. With no sessions at all there is
// nothing to measure against, so we surface a nudge (daysSinceLastSession null).
export function checkMissedSession(sessions, asOfDate) {
  const dates = sessions.map((s) => s.sessionDate);
  if (dates.length === 0) {
    return { daysSinceLastSession: null, shouldNudge: true };
  }
  const mostRecent = dates.reduce((a, b) => (a > b ? a : b));
  const daysSinceLastSession = daysBefore(mostRecent, asOfDate);
  return {
    daysSinceLastSession,
    shouldNudge: daysSinceLastSession >= ADHERENCE_NUDGE_DAYS,
  };
}

// Distinct session dates within the trailing 7 days of asOfDate, compared to
// the 3–4x/week target. Distinct dates so two logs on one day count once.
export function weeklyAdherence(sessions, asOfDate) {
  const inWindow = new Set(
    sessions
      .map((s) => s.sessionDate)
      .filter((d) => withinTrailingWindow(d, asOfDate, WEEK_DAYS))
  );
  const sessionCount = inWindow.size;
  return {
    sessionCount,
    onTarget: sessionCount >= ADHERENCE_WEEKLY_TARGET,
  };
}
