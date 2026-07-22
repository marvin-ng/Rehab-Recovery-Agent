// Phase 4 — daily missed-session nudge (EventBridge Scheduler, daily 07:00 ET).
//
// Queries the single most recent session (the proven Phase 1 pattern), runs the
// pure checkMissedSession against today's date, and emails a nudge only when one
// is due. Reports the gap as a fact plus the prescribed target — no
// encouragement language, no recommendation (clinical boundary).

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, SESSIONS_TABLE, SESSION_PK } from "../lib/ddb.mjs";
import { checkMissedSession } from "../logic/adherence.mjs";
import { sendRehabEmail } from "../lib/email.mjs";

// Today as UTC "YYYY-MM-DD". Scheduler fires at 07:00 ET (11:00/12:00 UTC), so
// the UTC calendar day matches the ET day at fire time.
const todayUTC = () => new Date().toISOString().slice(0, 10);

export const handler = async () => {
  const asOfDate = todayUTC();

  // Most recent session only — ScanIndexForward:false + Limit:1. A trailing
  // N-day window would return empty (and misreport) once a real gap exceeds N.
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: "PK = :p",
      ExpressionAttributeValues: { ":p": SESSION_PK },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  const { daysSinceLastSession, shouldNudge } = checkMissedSession(Items, asOfDate);

  // Logged on every invocation, nudge or not, so CloudWatch shows the real decision.
  console.log(
    `Nudge check: daysSinceLastSession=${daysSinceLastSession}, shouldNudge=${shouldNudge}`
  );

  if (!shouldNudge) {
    return { nudged: false, daysSinceLastSession };
  }

  const subject = "Rehab check-in";
  const body =
    daysSinceLastSession === null
      ? "No logged sessions yet. Your program calls for 3-4x/week."
      : `It's been ${daysSinceLastSession} days since your last logged session. Your program calls for 3-4x/week.`;

  await sendRehabEmail({ subject, body });
  return { nudged: true, daysSinceLastSession };
};
