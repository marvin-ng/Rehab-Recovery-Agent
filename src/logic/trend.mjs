// Trend narration for the three session ratings. Compares the average over the
// most recent window against the average over the equal window before it, and
// reports DIRECTION ONLY — never a cause. "trended toward less pain over the
// last two weeks," never "improving because X" or "recovering well." Reporting
// the pattern is allowed; explaining why it happened is over the clinical line.
// Pure: sessions are already-fetched plain data, asOfDate is an explicit
// "YYYY-MM-DD". No AWS, no clock, no model.
import { daysBefore } from "./dates.mjs";
import { TREND_WINDOW_DAYS, TREND_SIGNIFICANT_SHIFT } from "./thresholds.mjs";

// The three session-level ratings and their polarity. `higherIsBetter:false`
// means a downward shift is the improving direction (pain, stiffness);
// confidence is the opposite.
const METRICS = [
  { key: "painRating", higherIsBetter: false, less: "less pain", more: "more pain" },
  { key: "stiffnessRating", higherIsBetter: false, less: "less stiffness", more: "more stiffness" },
  { key: "confidenceRating", higherIsBetter: true, less: "lower confidence", more: "higher confidence" },
];

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Ratings for one metric whose session date falls in [startDay, endDay) days
// before asOfDate. Ignores sessions missing that rating.
function windowValues(sessions, asOfDate, metricKey, startDay, endDay) {
  const out = [];
  for (const s of sessions) {
    const diff = daysBefore(s.sessionDate, asOfDate);
    if (diff < startDay || diff >= endDay) continue;
    const v = s[metricKey];
    if (typeof v === "number") out.push(v);
  }
  return out;
}

function narrate(metric, direction) {
  if (direction === "improving") {
    return `${metric.key} trended toward ${metric.higherIsBetter ? metric.more : metric.less} over the last two weeks.`;
  }
  if (direction === "worsening") {
    return `${metric.key} trended toward ${metric.higherIsBetter ? metric.less : metric.more} over the last two weeks.`;
  }
  if (direction === "plateauing") {
    return `${metric.key} held roughly steady over the last two weeks.`;
  }
  return `${metric.key} has too few sessions in one of the two windows to compare.`;
}

// For each metric, direction is improving / worsening / plateauing, or
// insufficient_data when either window is empty. Returns one result per metric.
export function computeTrend(sessions, asOfDate) {
  return METRICS.map((metric) => {
    const recent = windowValues(sessions, asOfDate, metric.key, 0, TREND_WINDOW_DAYS);
    const prior = windowValues(
      sessions,
      asOfDate,
      metric.key,
      TREND_WINDOW_DAYS,
      TREND_WINDOW_DAYS * 2
    );

    if (recent.length === 0 || prior.length === 0) {
      return {
        metric: metric.key,
        direction: "insufficient_data",
        narrative: narrate(metric, "insufficient_data"),
      };
    }

    const recentAvg = average(recent);
    const priorAvg = average(prior);
    const delta = recentAvg - priorAvg;
    // Signed so that positive always means "moved in the good direction."
    const goodShift = metric.higherIsBetter ? delta : -delta;

    let direction = "plateauing";
    if (goodShift >= TREND_SIGNIFICANT_SHIFT) direction = "improving";
    else if (goodShift <= -TREND_SIGNIFICANT_SHIFT) direction = "worsening";

    return {
      metric: metric.key,
      direction,
      recentAvg: round2(recentAvg),
      priorAvg: round2(priorAvg),
      delta: round2(delta),
      narrative: narrate(metric, direction),
    };
  });
}
