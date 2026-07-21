// Side-asymmetry detection across per-side exercises. Counts moderate-or-severe
// tagged instances per side within the look-back window and flags a lopsided
// pattern — it reports the pattern only, never a cause or a recommendation.
// Pure: sessions + Program items are already-fetched plain data, asOfDate is an
// explicit "YYYY-MM-DD". No AWS, no clock, no model.
import { daysBefore } from "./dates.mjs";
import { isPerformed } from "./sessions.mjs";
import {
  ASYMMETRY_MIN_SAMPLE,
  ASYMMETRY_FLAG_DIFFERENTIAL,
  ASYMMETRY_WINDOW_DAYS,
} from "./thresholds.mjs";

const SIDES = ["left", "right"];

// The current per-side exercise set, read live from the versioned Program so
// this stays in sync as exercises retire/progress — never a hardcoded list.
export function activePerSideExercises(programItems) {
  return programItems.filter((p) => p.perSide === true && p.status === "active");
}

// The moderate-or-severe tag on a side (if any). Returns the tag so the caller
// can read its symptomType; null when the side shows nothing moderate+.
function moderatePlusTag(tags) {
  if (!Array.isArray(tags)) return null;
  return (
    tags.find((t) => t.severity === "moderate" || t.severity === "severe") ||
    null
  );
}

// Per exerciseId, tally per side over the window:
//   total  = sessions where that side was actually performed (completed===true)
//   count  = of those, how many carried a moderate-or-severe tag
// Also tracks the symptomType of the most recent moderate+ instance per side,
// so a flagged result can name the pattern factually. A logged-but-skipped
// instance never counts toward performed totals.
export function detectAsymmetry(exerciseId, sessions, asOfDate) {
  const counts = { left: 0, right: 0 };
  const totals = { left: 0, right: 0 };
  const latest = { left: null, right: null }; // { date, symptomType }

  for (const session of sessions) {
    const diff = daysBefore(session.sessionDate, asOfDate);
    if (diff < 0 || diff > ASYMMETRY_WINDOW_DAYS) continue;

    const entry = (session.completedExercises || []).find(
      (e) => e.exerciseId === exerciseId
    );
    if (!entry) continue;

    for (const side of SIDES) {
      const sideObj = entry.sides?.[side];
      if (!isPerformed(sideObj)) continue;
      totals[side] += 1;
      const tag = moderatePlusTag(sideObj.tags);
      if (tag) {
        counts[side] += 1;
        if (!latest[side] || session.sessionDate > latest[side].date) {
          latest[side] = { date: session.sessionDate, symptomType: tag.symptomType };
        }
      }
    }
  }

  const base = {
    exerciseId,
    leftCount: counts.left,
    rightCount: counts.right,
    leftTotal: totals.left,
    rightTotal: totals.right,
  };

  // Too few moderate+ instances on both sides to judge — don't guess.
  if (Math.max(counts.left, counts.right) < ASYMMETRY_MIN_SAMPLE) {
    return { ...base, status: "insufficient_data" };
  }

  // One side clearly heavier than the other.
  if (Math.abs(counts.left - counts.right) >= ASYMMETRY_FLAG_DIFFERENTIAL) {
    const side = counts.left > counts.right ? "left" : "right";
    return {
      ...base,
      status: "flagged",
      side,
      symptomType: latest[side]?.symptomType ?? "none",
    };
  }

  return { ...base, status: "no_pattern" };
}

// Convenience wrapper: run detectAsymmetry across every active per-side
// exercise and enrich each result with the exercise's human name (for the
// escalation template, which detectAsymmetry itself can't see).
export function detectActiveAsymmetries(programItems, sessions, asOfDate) {
  return activePerSideExercises(programItems).map((p) => ({
    ...detectAsymmetry(p.exerciseId, sessions, asOfDate),
    exerciseName: p.name,
  }));
}
