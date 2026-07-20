// Live verification of the Phase 1 data layer. Runs 6 checks against the real
// AWS tables, prints PASS/FAIL for each, and exits non-zero if any check fails.
// Inserts a small set of synthetic sessions to exercise the query patterns and
// ALWAYS deletes them (finally), then proves the Sessions table is empty.
// Run: node scripts/verify-data.mjs
import assert from "node:assert/strict";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  QueryCommand,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ddb,
  raw,
  PROGRAM_TABLE,
  SESSIONS_TABLE,
  PROGRAM_PK,
  SESSION_PK,
} from "./lib/ddb.mjs";

let failures = 0;

async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`✅ PASS — ${label}${detail ? `: ${detail}` : ""}`);
  } catch (err) {
    failures += 1;
    console.log(`❌ FAIL — ${label}: ${err.message}`);
  }
}

// ISO date (YYYY-MM-DD) offset from today by `days` (negative = past).
function isoDay(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const EXPECTED_PROGRAM_FIELDS = [
  "name",
  "section",
  "targetSets",
  "targetReps",
  "perSide",
  "cues",
];

// A fully-populated session, dated today, used for the nested round-trip check.
function makeSession(date, sessionId, painRating) {
  return {
    PK: SESSION_PK,
    SK: date,
    sessionDate: date,
    sessionId,
    completedExercises: [
      {
        exerciseId: "single_leg_rdl",
        sides: {
          left: { completed: true, rawNote: "felt tight at rep 6", tags: [] },
          right: { completed: false, rawNote: "", tags: [] },
        },
      },
      {
        exerciseId: "face_pulls",
        sides: {
          left: { completed: true, rawNote: "", tags: [] },
          right: { completed: true, rawNote: "", tags: [] },
        },
      },
    ],
    painRating,
    stiffnessRating: 3,
    confidenceRating: 4,
    loggedAt: `${date}T18:30:00Z`,
  };
}

// Synthetic sessions: 3 inside the last-7-days window (offsets 0, -3, -6) and
// one outside it (-10) as a negative control for the range query.
const today = isoDay(0);
const day3 = isoDay(-3);
const day6 = isoDay(-6);
const day10 = isoDay(-10);

const synthetic = [
  makeSession(today, "verify-roundtrip", 2),
  makeSession(day3, "verify-d3", 1),
  makeSession(day6, "verify-d6", 3),
  makeSession(day10, "verify-d10-outside", 2),
];

async function run() {
  // --- Check 1: both tables ACTIVE ---
  await check("both tables ACTIVE", async () => {
    const statuses = {};
    for (const t of [PROGRAM_TABLE, SESSIONS_TABLE]) {
      const res = await raw.send(new DescribeTableCommand({ TableName: t }));
      statuses[t] = res.Table.TableStatus;
      assert.equal(res.Table.TableStatus, "ACTIVE", `${t} not ACTIVE`);
    }
    return JSON.stringify(statuses);
  });

  // --- Check 2: Program has all 9 items, correctly shaped ---
  await check("Program: 9 items readable & correctly shaped", async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: PROGRAM_TABLE,
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": PROGRAM_PK },
      })
    );
    assert.equal(res.Count, 9, `expected 9 items, got ${res.Count}`);
    for (const it of res.Items) {
      assert.equal(it.status, "active", `${it.SK}: status not active`);
      assert.ok(
        Array.isArray(it.versionHistory) && it.versionHistory.length === 0,
        `${it.SK}: versionHistory not empty list`
      );
      assert.equal(it.exerciseId, it.SK, `${it.SK}: exerciseId != SK`);
      assert.equal(typeof it.perSide, "boolean", `${it.SK}: perSide not boolean`);
      for (const f of EXPECTED_PROGRAM_FIELDS) {
        assert.ok(it[f] !== undefined && it[f] !== null, `${it.SK}: missing ${f}`);
      }
    }
    return `Count=9, all active, versionHistory=[]`;
  });

  try {
    // Insert synthetic sessions up front (needed for checks 3, 4, 5).
    for (const s of synthetic) {
      await ddb.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: s }));
    }

    // --- Check 3: nested completedExercises round-trips ---
    await check("Sessions nested round-trip (maps/lists/bools)", async () => {
      const written = synthetic[0]; // the fully-populated "today" session
      const res = await ddb.send(
        new GetCommand({
          TableName: SESSIONS_TABLE,
          Key: { PK: SESSION_PK, SK: written.SK },
        })
      );
      assert.ok(res.Item, "round-trip item not found");
      assert.deepStrictEqual(res.Item, written, "round-trip mismatch");
      return `deep-equal on ${written.SK} (sessionId=${written.sessionId})`;
    });

    // --- Check 4: most recent session ---
    await check("most recent session (ScanIndexForward:false, Limit:1)", async () => {
      const res = await ddb.send(
        new QueryCommand({
          TableName: SESSIONS_TABLE,
          KeyConditionExpression: "PK = :p",
          ExpressionAttributeValues: { ":p": SESSION_PK },
          ScanIndexForward: false,
          Limit: 1,
        })
      );
      assert.equal(res.Count, 1, "expected exactly 1 item");
      assert.equal(res.Items[0].SK, today, `expected most-recent ${today}, got ${res.Items[0].SK}`);
      return `latest = ${res.Items[0].SK}`;
    });

    // --- Check 5: last-7-days range query ---
    await check("last-7-days range query (BETWEEN)", async () => {
      const start = isoDay(-6);
      const end = today;
      const res = await ddb.send(
        new QueryCommand({
          TableName: SESSIONS_TABLE,
          KeyConditionExpression: "PK = :p AND SK BETWEEN :start AND :end",
          ExpressionAttributeValues: { ":p": SESSION_PK, ":start": start, ":end": end },
        })
      );
      const dates = res.Items.map((i) => i.SK).sort();
      // Expect the 3 in-window rows; the -10 negative control must be excluded.
      assert.deepStrictEqual(dates, [day6, day3, today].sort(), `unexpected window contents: ${dates}`);
      assert.ok(!dates.includes(day10), "negative control (-10d) leaked into window");
      return `window ${start}..${end} returned ${dates.length} rows: ${dates.join(", ")}`;
    });
  } finally {
    // Cleanup ALWAYS runs, even if checks 3-5 threw, so no synthetic rows are left behind.
    for (const s of synthetic) {
      await ddb.send(
        new DeleteCommand({ TableName: SESSIONS_TABLE, Key: { PK: SESSION_PK, SK: s.SK } })
      );
    }
  }

  // --- Check 6: Sessions pristine after cleanup ---
  await check("Sessions pristine after cleanup (Count===0)", async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": SESSION_PK },
        Select: "COUNT",
      })
    );
    assert.equal(res.Count, 0, `expected 0 sessions after cleanup, got ${res.Count}`);
    return "Count=0";
  });
}

run()
  .then(() => {
    console.log("");
    if (failures > 0) {
      console.log(`RESULT: ${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log("RESULT: all 6 checks PASSED");
  })
  .catch((err) => {
    console.error("❌ verify harness error:", err);
    process.exit(1);
  });
