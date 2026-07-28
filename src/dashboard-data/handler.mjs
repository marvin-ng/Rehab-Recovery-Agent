// Phase 5 (Part A) — dashboard-data endpoint (Lambda Function URL, read-only).
//
// One GET that the on-demand frontend calls to render both views. It fetches
// active Program items + a ~60-day Sessions window, then runs the EXISTING
// Phase 3 pure logic (adherence, asymmetry, escalation, trend) directly — it
// re-implements none of that math. Returns a single JSON payload:
//   { adherence, asymmetryResults, escalations, trend, recentSessions,
//     programItems }
// programItems is included so the logging form can render without a second
// endpoint; recentSessions is a display-only history list (ratings + per-side
// completed/rawNote/tags), NOT recomputed from the raw items by the frontend.
//
// This REPORTS patterns only. It never diagnoses, recommends, or explains why —
// all wording still comes from the Phase 3 templates (compileEscalations), not
// from this file. recentSessions carries raw notes for read-back, which is
// display data and does not touch the escalation boundary.
//
// AUTH: Function URL is AuthType NONE at the edge; the shared x-api-key secret
// is checked HERE first, before any query, via the shared verifyApiSecret.

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, SESSIONS_TABLE, PROGRAM_TABLE, SESSION_PK, PROGRAM_PK } from "../lib/ddb.mjs";
import { verifyApiSecret } from "../lib/auth.mjs";
import { weeklyAdherence } from "../logic/adherence.mjs";
import { detectActiveAsymmetries } from "../logic/asymmetry.mjs";
import { compileEscalations } from "../logic/escalation.mjs";
import { computeTrend } from "../logic/trend.mjs";

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 60; // comfortably covers asymmetry (30) + trend (up to 28)

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

const todayUTC = () => new Date().toISOString().slice(0, 10);

function daysAgoUTC(asOfDate, n) {
  const [y, m, d] = asOfDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * MS_PER_DAY).toISOString().slice(0, 10);
}

async function querySessionWindow(start, end) {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: "PK = :p AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: { ":p": SESSION_PK, ":start": start, ":end": end },
    })
  );
  return Items;
}

async function queryProgram() {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: PROGRAM_TABLE,
      KeyConditionExpression: "PK = :p",
      ExpressionAttributeValues: { ":p": PROGRAM_PK },
    })
  );
  return Items;
}

// Trim a stored Session item to what a history view needs: ratings, the
// whole-session generalNote, plus, per exercise, each present side's completed
// flag, raw note, and tags. Newest first is applied by the caller (DynamoDB
// returns ascending by SK).
//
// generalNote is relayed VERBATIM and carries no tags — it is never classified
// (see D-27). Sessions logged before this field existed simply have none, hence
// the "" fallback.
function toRecentSession(item) {
  const exercises = (item.completedExercises || []).map((ex) => {
    const sides = {};
    for (const [side, sideObj] of Object.entries(ex.sides || {})) {
      sides[side] = {
        completed: sideObj?.completed === true,
        rawNote: sideObj?.rawNote ?? "",
        tags: Array.isArray(sideObj?.tags) ? sideObj.tags : [],
      };
    }
    return { exerciseId: ex.exerciseId, sides };
  });
  return {
    sessionDate: item.sessionDate,
    painRating: item.painRating,
    stiffnessRating: item.stiffnessRating,
    confidenceRating: item.confidenceRating,
    generalNote: typeof item.generalNote === "string" ? item.generalNote : "",
    exercises,
  };
}

export const handler = async (event = {}) => {
  // --- AUTH FIRST: before any query. Generic 401, never reveals missing vs
  // wrong (shared with rehab-log-session via lib/auth). ---
  if (!verifyApiSecret(event)) {
    return json(401, { error: "unauthorized" });
  }

  const asOfDate = todayUTC();
  const start = daysAgoUTC(asOfDate, WINDOW_DAYS);

  const [sessions, allProgram] = await Promise.all([
    querySessionWindow(start, asOfDate),
    queryProgram(),
  ]);

  // "The current program" is the active set — filter here so the frontend
  // renders exactly what asymmetry/adherence reason over.
  const programItems = allProgram.filter((p) => p.status === "active");

  const adherence = weeklyAdherence(sessions, asOfDate);
  const asymmetryResults = detectActiveAsymmetries(programItems, sessions, asOfDate);
  const escalations = compileEscalations(sessions, asymmetryResults, asOfDate);
  const trend = computeTrend(sessions, asOfDate);

  // Newest first for the history view.
  const recentSessions = sessions
    .map(toRecentSession)
    .sort((a, b) => (a.sessionDate < b.sessionDate ? 1 : -1));

  return json(200, {
    asOfDate,
    adherence,
    asymmetryResults,
    escalations,
    trend,
    recentSessions,
    programItems,
  });
};
