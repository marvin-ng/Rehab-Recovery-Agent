// Escalation compiler: turns flagged symptoms and flagged asymmetry patterns
// into a single list of physio-ready questions. This function reports patterns
// and hands them to the physio — it NEVER recommends, diagnoses, or explains
// why. The no-recommendation guarantee is enforced by the templates below
// (structured fields only, no free-text passthrough), not by any model; there
// is no model involved in this function at all.
// Pure: sessions + asymmetryResults are already-fetched plain data, asOfDate is
// an explicit "YYYY-MM-DD". No AWS, no clock.
import { daysBefore } from "./dates.mjs";
import { isPerformed } from "./sessions.mjs";
import { ASYMMETRY_WINDOW_DAYS } from "./thresholds.mjs";

// Recommendation language that must never appear in a compiled observation or
// question. Exported so the verify harness asserts against the same list the
// templates are written to avoid — one source of truth.
export const BANNED_WORDS = [
  "should",
  "try",
  "consider doing",
  "modify",
  "reduce",
  "increase",
];

// Every escalation ends with the same physio-referral prompt — a question to
// raise, never an instruction to act on.
const PHYSIO_QUESTION = "Worth asking your physio whether this needs attention.";

const SIDES = ["left", "right", "n-a"];

function sidePrefix(side) {
  if (side === "left") return "Left side";
  if (side === "right") return "Right side";
  return null; // n-a: no side prefix, the exercise name is the subject
}

// Best-effort human name: reuse names already carried on asymmetryResults;
// otherwise humanize the exerciseId ("push_up_plus" -> "Push Up Plus").
function nameLookup(asymmetryResults) {
  const map = new Map();
  for (const r of asymmetryResults) {
    if (r.exerciseId && r.exerciseName) map.set(r.exerciseId, r.exerciseName);
  }
  return (exerciseId) =>
    map.get(exerciseId) ||
    exerciseId
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
}

// Group flagForReview:true tags in the window by exerciseId + side, so a rough
// week compresses into one line per exercise/side instead of one per instance.
function collectSymptomGroups(sessions, asOfDate, nameFor) {
  const groups = new Map(); // key: `${exerciseId}|${side}`

  for (const session of sessions) {
    const diff = daysBefore(session.sessionDate, asOfDate);
    if (diff < 0 || diff > ASYMMETRY_WINDOW_DAYS) continue;

    for (const entry of session.completedExercises || []) {
      for (const side of SIDES) {
        const sideObj = entry.sides?.[side];
        // Denominator matches asymmetry: only performed instances count
        // (shared isPerformed, so the rule can't drift between the two paths).
        if (!isPerformed(sideObj)) continue;

        const key = `${entry.exerciseId}|${side}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            exerciseId: entry.exerciseId,
            exerciseName: nameFor(entry.exerciseId),
            side,
            total: 0,
            count: 0,
            mostRecentDate: null,
            symptomType: "none",
          };
          groups.set(key, g);
        }
        g.total += 1;

        const flagged = (sideObj.tags || []).find((t) => t.flagForReview === true);
        if (flagged) {
          g.count += 1;
          if (!g.mostRecentDate || session.sessionDate > g.mostRecentDate) {
            g.mostRecentDate = session.sessionDate;
            // Prefer a named symptom for the most recent flag; keyword-only
            // flags (symptomType "none") fall back to the review phrasing.
            if (flagged.symptomType && flagged.symptomType !== "none") {
              g.symptomType = flagged.symptomType;
            }
          }
        }
      }
    }
  }

  // Keep only groups that actually had a flag.
  return [...groups.values()].filter((g) => g.count > 0);
}

function symptomObservation(g) {
  const prefix = sidePrefix(g.side);
  const tail = `in ${g.count} of your last ${g.total} ${g.exerciseName} sessions (most recent ${g.mostRecentDate}).`;
  if (g.symptomType !== "none") {
    // e.g. "Right side has been flagged for pain in 2 of your last 5 Single-Leg RDL sessions (most recent 2026-07-15)."
    return prefix
      ? `${prefix} has been flagged for ${g.symptomType} ${tail}`
      : `${g.exerciseName} has been flagged for ${g.symptomType} in ${g.count} of your last ${g.total} sessions (most recent ${g.mostRecentDate}).`;
  }
  // Keyword-triggered flag with no named symptom.
  return prefix
    ? `${prefix} ${g.exerciseName} has been flagged for review in ${g.count} of your last ${g.total} sessions (most recent ${g.mostRecentDate}).`
    : `${g.exerciseName} has been flagged for review in ${g.count} of your last ${g.total} sessions (most recent ${g.mostRecentDate}).`;
}

function asymmetryObservation(r) {
  const prefix = sidePrefix(r.side) || "One side";
  const symptom = r.symptomType && r.symptomType !== "none" ? r.symptomType : "symptoms";
  const total = r.side === "left" ? r.leftTotal : r.rightTotal;
  const count = r.side === "left" ? r.leftCount : r.rightCount;
  // e.g. "Right side has shown moderate or higher instability in 3 of your last 5 Single-Leg RDL sessions."
  return `${prefix} has shown moderate or higher ${symptom} in ${count} of your last ${total} ${r.exerciseName} sessions.`;
}

// Compile all escalations into one list. Symptom flags first (aggregated per
// exercise+side), then flagged asymmetry patterns.
export function compileEscalations(sessions, asymmetryResults, asOfDate) {
  const nameFor = nameLookup(asymmetryResults);
  const items = [];

  for (const g of collectSymptomGroups(sessions, asOfDate, nameFor)) {
    items.push({
      type: "symptom_flag",
      exerciseId: g.exerciseId,
      side: g.side,
      observation: symptomObservation(g),
      question: PHYSIO_QUESTION,
    });
  }

  for (const r of asymmetryResults) {
    if (r.status !== "flagged") continue;
    items.push({
      type: "asymmetry",
      exerciseId: r.exerciseId,
      side: r.side,
      observation: asymmetryObservation(r),
      question: PHYSIO_QUESTION,
    });
  }

  return items;
}
