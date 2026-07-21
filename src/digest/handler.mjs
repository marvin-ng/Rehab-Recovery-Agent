// Phase 4 — weekly & monthly digest (EventBridge Scheduler; Fri 07:00 ET weekly,
// 28th 07:00 ET monthly). One handler, branches on event.digestType.
//
// Composes a therapist-ready plain-text summary from the pure Phase 3 logic:
// adherence status, compiled escalations (observation + fixed physio question),
// and — monthly only — the trend section. It REPORTS patterns only. It never
// diagnoses, never explains why, never recommends (clinical boundary). All
// wording comes from the Phase 3 templates, not from this file.

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, SESSIONS_TABLE, PROGRAM_TABLE, SESSION_PK, PROGRAM_PK } from "../lib/ddb.mjs";
import { weeklyAdherence } from "../logic/adherence.mjs";
import { detectActiveAsymmetries } from "../logic/asymmetry.mjs";
import { compileEscalations } from "../logic/escalation.mjs";
import { computeTrend } from "../logic/trend.mjs";
import { withinTrailingWindow } from "../logic/dates.mjs";
import { sendRehabEmail } from "../lib/email.mjs";

const MS_PER_DAY = 86_400_000;
const WINDOW_DAYS = 31; // covers asymmetry (30) and trend (up to 27) windows
const WEEK_DAYS = 7;

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

// Assemble the plain-text body. `trend` is null for weekly.
function composeBody({ digestType, asOfDate, adherence, escalations, trend }) {
  const lines = [];
  const label = digestType === "monthly" ? "Monthly" : "Weekly";
  lines.push(`${label} rehab summary — as of ${asOfDate}`);
  lines.push("");

  // Adherence
  lines.push("ADHERENCE");
  lines.push(
    `Sessions logged in the last 7 days: ${adherence.sessionCount} (target: 3-4/week).`
  );
  lines.push(adherence.onTarget ? "On target." : "Below the weekly target.");
  lines.push("");

  // Escalations — patterns to raise with the physio
  lines.push("FLAGS TO BRING UP WITH YOUR PHYSIO");
  if (escalations.length === 0) {
    lines.push("No flags this period.");
  } else {
    for (const e of escalations) {
      lines.push(`- ${e.observation} ${e.question}`);
    }
  }

  // Trend — monthly only
  if (trend) {
    lines.push("");
    lines.push("TREND (last two weeks vs the prior two)");
    for (const t of trend) {
      lines.push(`- ${t.narrative}`);
    }
  }

  return lines.join("\n");
}

export { composeBody };

export const handler = async (event = {}) => {
  const digestType = event.digestType;
  if (digestType !== "weekly" && digestType !== "monthly") {
    throw new Error(`invalid digestType: ${JSON.stringify(digestType)} (expected weekly|monthly)`);
  }

  const asOfDate = todayUTC();
  const start = daysAgoUTC(asOfDate, WINDOW_DAYS);

  const [sessions, programItems] = await Promise.all([
    querySessionWindow(start, asOfDate),
    queryProgram(),
  ]);

  // Adherence and asymmetry both use the full window — asymmetry genuinely
  // needs the ~30-day history to reach its minimum sample.
  const adherence = weeklyAdherence(sessions, asOfDate);
  const asymmetry = detectActiveAsymmetries(programItems, sessions, asOfDate);

  // Escalation scoping differs by cadence: weekly reports only new-this-week
  // flags (7-day session set) so a flag doesn't re-surface for four straight
  // weeks; monthly restates over the full window (a monthly roundup may repeat).
  const escalationSessions =
    digestType === "weekly"
      ? sessions.filter((s) => withinTrailingWindow(s.sessionDate, asOfDate, WEEK_DAYS))
      : sessions;
  const escalations = compileEscalations(escalationSessions, asymmetry, asOfDate);

  const trend = digestType === "monthly" ? computeTrend(sessions, asOfDate) : null;

  const subject = digestType === "monthly" ? "Monthly rehab summary" : "Weekly rehab summary";
  const body = composeBody({ digestType, asOfDate, adherence, escalations, trend });

  await sendRehabEmail({ subject, body });
  return { digestType, escalationCount: escalations.length, includedTrend: Boolean(trend) };
};
