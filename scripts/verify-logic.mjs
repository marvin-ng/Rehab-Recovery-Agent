// Live verification of the Phase 3 deterministic logic layer. Seeds synthetic
// sessions into the real rehab-sessions table (reusing the Phase 1
// insert/assert/delete-in-finally pattern), fetches real Program items live for
// the per-side exercise list, runs the pure logic functions against the
// fetched data, and proves the table is empty again afterward.
// The logic under test is pure (no AWS, no clock, no model) — this harness only
// supplies it already-fetched data plus an explicit reference date.
// Run: node scripts/verify-logic.mjs
import assert from "node:assert/strict";
import { QueryCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ddb,
  PROGRAM_TABLE,
  SESSIONS_TABLE,
  PROGRAM_PK,
  SESSION_PK,
} from "./lib/ddb.mjs";
import { checkMissedSession, weeklyAdherence } from "../src/logic/adherence.mjs";
import {
  detectAsymmetry,
  activePerSideExercises,
} from "../src/logic/asymmetry.mjs";
import { compileEscalations, BANNED_WORDS } from "../src/logic/escalation.mjs";
import { computeTrend } from "../src/logic/trend.mjs";

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

// Fixed reference date — the logic never reads the clock, so every window is
// derived deterministically from this constant.
const AS_OF = "2026-07-20";

// "YYYY-MM-DD" for `offset` days before AS_OF (test-side date math only).
function ago(offset) {
  const [y, m, d] = AS_OF.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - offset);
  return dt.toISOString().slice(0, 10);
}

// --- synthetic-data builders ---
function tag(symptomType, severity, flagForReview) {
  return { symptomType, severity, flagForReview };
}
function side(completed, tags = []) {
  return { completed, rawNote: "", tags };
}
function exEntry(exerciseId, sides) {
  return { exerciseId, sides };
}
function session(date, { completedExercises = [], pain = 0, stiffness = 0, confidence = 0 } = {}) {
  return {
    PK: SESSION_PK,
    SK: date,
    sessionDate: date,
    sessionId: `verify-${date}`,
    completedExercises,
    painRating: pain,
    stiffnessRating: stiffness,
    confidenceRating: confidence,
    loggedAt: `${date}T18:30:00Z`,
  };
}

// Seed the given sessions live, hand the round-tripped items to `fn`, and ALWAYS
// delete them afterward so no case leaves rows behind.
async function withSeededSessions(sessions, fn) {
  try {
    for (const s of sessions) {
      await ddb.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: s }));
    }
    const res = await ddb.send(
      new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": SESSION_PK },
      })
    );
    return await fn(res.Items);
  } finally {
    for (const s of sessions) {
      await ddb.send(
        new DeleteCommand({ TableName: SESSIONS_TABLE, Key: { PK: SESSION_PK, SK: s.SK } })
      );
    }
  }
}

async function run() {
  // --- Live Program fetch: derive the per-side exercise list from real data ---
  let programItems = [];
  await check("Program items fetched live; per-side list derived", async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: PROGRAM_TABLE,
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": PROGRAM_PK },
      })
    );
    programItems = res.Items;
    const perSide = activePerSideExercises(programItems);
    assert.ok(perSide.length > 0, "no active per-side exercises found");
    return `${perSide.length} active per-side exercises: ${perSide.map((p) => p.exerciseId).join(", ")}`;
  });
  const nameOf = (id) => programItems.find((p) => p.exerciseId === id)?.name;

  // --- (a) On-target adherence: 3 distinct dates in the last 7 days ---
  await check("(a) on-target adherence (3 sessions in last 7 days)", async () => {
    const sessions = [ago(0), ago(2), ago(5)].map((d) => session(d, { pain: 2 }));
    return withSeededSessions(sessions, (items) => {
      const wa = weeklyAdherence(items, AS_OF);
      assert.equal(wa.sessionCount, 3, `sessionCount ${wa.sessionCount}`);
      assert.equal(wa.onTarget, true, "expected onTarget true");
      const ms = checkMissedSession(items, AS_OF);
      assert.equal(ms.shouldNudge, false, "expected no nudge when logged today");
      return `sessionCount=${wa.sessionCount}, onTarget=${wa.onTarget}, daysSinceLast=${ms.daysSinceLastSession}`;
    });
  });

  // --- (b) Missed session: most recent session 3+ days before asOfDate ---
  await check("(b) missed session (most recent 3 days ago)", async () => {
    const sessions = [ago(3), ago(6)].map((d) => session(d, { pain: 2 }));
    return withSeededSessions(sessions, (items) => {
      const ms = checkMissedSession(items, AS_OF);
      assert.equal(ms.daysSinceLastSession, 3, `daysSince ${ms.daysSinceLastSession}`);
      assert.equal(ms.shouldNudge, true, "expected nudge");
      const wa = weeklyAdherence(items, AS_OF);
      assert.equal(wa.onTarget, false, "2 sessions should be below target");
      return `daysSinceLast=${ms.daysSinceLastSession}, shouldNudge=${ms.shouldNudge}, weekCount=${wa.sessionCount}`;
    });
  });

  // --- (c) Asymmetry insufficient data: only 2 moderate+ on one side ---
  await check("(c) asymmetry insufficient_data (2 moderate+ on right)", async () => {
    const sessions = [ago(1), ago(4)].map((d) =>
      session(d, {
        completedExercises: [
          exEntry("single_leg_rdl", {
            left: side(true, []),
            right: side(true, [tag("pain", "moderate", true)]),
          }),
        ],
      })
    );
    return withSeededSessions(sessions, (items) => {
      const r = detectAsymmetry("single_leg_rdl", items, AS_OF);
      assert.equal(r.status, "insufficient_data", `status ${r.status}`);
      assert.equal(r.rightCount, 2, `rightCount ${r.rightCount}`);
      assert.equal(r.leftCount, 0, `leftCount ${r.leftCount}`);
      return `status=${r.status}, left=${r.leftCount}, right=${r.rightCount}`;
    });
  });

  // --- (d) Asymmetry flagged: right moderate+ in 3 sessions, left in 0 ---
  await check("(d) asymmetry flagged (right moderate+ x3, left x0)", async () => {
    const sessions = [ago(1), ago(4), ago(7)].map((d) =>
      session(d, {
        completedExercises: [
          exEntry("single_leg_squat_step_down", {
            left: side(true, []),
            right: side(true, [tag("instability", "moderate", true)]),
          }),
        ],
      })
    );
    return withSeededSessions(sessions, (items) => {
      const r = detectAsymmetry("single_leg_squat_step_down", items, AS_OF);
      assert.equal(r.status, "flagged", `status ${r.status}`);
      assert.equal(r.side, "right", `side ${r.side}`);
      assert.equal(r.rightCount, 3, `rightCount ${r.rightCount}`);
      assert.equal(r.leftCount, 0, `leftCount ${r.leftCount}`);
      return `status=${r.status}, side=${r.side}, left=${r.leftCount}, right=${r.rightCount}`;
    });
  });

  // --- (e) Escalation compiler: aggregation + no banned recommendation words ---
  await check("(e) escalation compiler (aggregated flags, no banned words)", async () => {
    // Same exercise+side flagged across 3 sessions, 1 performed-but-not-flagged,
    // 1 skipped (completed:false — must NOT count toward the denominator).
    const sessions = [
      session(ago(2), {
        completedExercises: [
          exEntry("single_leg_rdl", { left: side(false, []), right: side(true, [tag("pain", "moderate", true)]) }),
        ],
      }),
      session(ago(5), {
        completedExercises: [
          exEntry("single_leg_rdl", { left: side(false, []), right: side(true, [tag("pain", "moderate", true)]) }),
        ],
      }),
      session(ago(8), {
        completedExercises: [
          exEntry("single_leg_rdl", { left: side(false, []), right: side(true, [tag("pain", "moderate", true)]) }),
        ],
      }),
      session(ago(11), {
        completedExercises: [
          exEntry("single_leg_rdl", { left: side(false, []), right: side(true, [tag("pain", "mild", false)]) }),
        ],
      }),
      session(ago(14), {
        completedExercises: [
          exEntry("single_leg_rdl", { left: side(false, []), right: side(false, []) }),
        ],
      }),
    ];
    // A flagged asymmetry result (computed separately in Phase 4). The rdl entry
    // is insufficient_data here — present only to supply the real exercise name,
    // exactly as detectActiveAsymmetries returns a named result per per-side ex.
    const asymResults = [
      {
        status: "flagged",
        side: "right",
        exerciseId: "single_leg_squat_step_down",
        exerciseName: nameOf("single_leg_squat_step_down"),
        leftCount: 0,
        rightCount: 3,
        leftTotal: 3,
        rightTotal: 3,
        symptomType: "instability",
      },
      {
        status: "insufficient_data",
        exerciseId: "single_leg_rdl",
        exerciseName: nameOf("single_leg_rdl"),
        leftCount: 0,
        rightCount: 0,
        leftTotal: 0,
        rightTotal: 0,
      },
    ];

    return withSeededSessions(sessions, (items) => {
      const escalations = compileEscalations(items, asymResults, AS_OF);

      const symptomItems = escalations.filter((e) => e.type === "symptom_flag");
      const asymItems = escalations.filter((e) => e.type === "asymmetry");

      // Aggregation: 3 flagged rdl-right sessions collapse to ONE line item.
      assert.equal(symptomItems.length, 1, `expected 1 symptom_flag, got ${symptomItems.length}`);
      // Denominator excludes the skipped session: 3 of 4, not 3 of 5.
      assert.match(symptomItems[0].observation, /3 of your last 4/, "expected '3 of your last 4'");
      assert.equal(asymItems.length, 1, `expected 1 asymmetry item, got ${asymItems.length}`);

      // Programmatic boundary check: no banned recommendation word anywhere.
      for (const e of escalations) {
        const haystack = `${e.observation} ${e.question}`.toLowerCase();
        for (const w of BANNED_WORDS) {
          assert.ok(!haystack.includes(w), `banned word "${w}" in: ${haystack}`);
        }
      }

      // Print the actual compiled text so the boundary language is visible.
      console.log("       --- compiled escalations ---");
      for (const e of escalations) {
        console.log(`       [${e.type}] ${e.observation}`);
        console.log(`                ${e.question}`);
      }
      return `${escalations.length} escalations (1 symptom_flag aggregated, 1 asymmetry), 0 banned words`;
    });
  });

  // --- (e2) Escalation keyword-backstop: flagged via keyword, symptomType none ---
  await check("(e2) escalation keyword-backstop flag (symptomType none)", async () => {
    // flagForReview true via the Phase 2 keyword backstop (e.g. a note like
    // "gave way") while the model tagged no symptom: symptomType "none". The
    // observation must fall back to neutral "flagged for review" phrasing — not
    // the nonsensical "flagged for none".
    const sessions = [ago(3), ago(9)].map((d) =>
      session(d, {
        completedExercises: [
          exEntry("single_leg_rdl", {
            left: side(false, []),
            right: side(true, [tag("none", "none", true)]),
          }),
        ],
      })
    );
    // rdl name supplied via a (non-flagged) named result, as Phase 4's
    // detectActiveAsymmetries would; no_pattern so it emits no asymmetry item.
    const asymResults = [
      {
        status: "no_pattern",
        exerciseId: "single_leg_rdl",
        exerciseName: nameOf("single_leg_rdl"),
        leftCount: 0,
        rightCount: 0,
        leftTotal: 2,
        rightTotal: 2,
      },
    ];

    return withSeededSessions(sessions, (items) => {
      const escalations = compileEscalations(items, asymResults, AS_OF);
      const symptomItems = escalations.filter((e) => e.type === "symptom_flag");
      assert.equal(symptomItems.length, 1, `expected 1 symptom_flag, got ${symptomItems.length}`);
      const obs = symptomItems[0].observation;
      assert.match(obs, /flagged for review/, "expected neutral 'flagged for review' phrasing");
      assert.doesNotMatch(obs, /flagged for none/, "must not read 'flagged for none'");
      for (const e of escalations) {
        const haystack = `${e.observation} ${e.question}`.toLowerCase();
        for (const w of BANNED_WORDS) {
          assert.ok(!haystack.includes(w), `banned word "${w}" in: ${haystack}`);
        }
      }
      console.log("       --- keyword-backstop escalation (symptomType none) ---");
      console.log(`       [${symptomItems[0].type}] ${obs}`);
      console.log(`                ${symptomItems[0].question}`);
      return `neutral 'flagged for review' phrasing, 0 banned words`;
    });
  });

  // --- (f) Trend: improving, worsening, plateauing in one pass ---
  await check("(f) trend improving/worsening/plateauing", async () => {
    // prior window (14–27d): pain 6, stiffness 2, confidence 5
    // recent window (0–13d): pain 3 (improving), stiffness 5 (worsening), confidence 5 (plateau)
    const sessions = [
      session(ago(24), { pain: 6, stiffness: 2, confidence: 5 }),
      session(ago(20), { pain: 6, stiffness: 2, confidence: 5 }),
      session(ago(6), { pain: 3, stiffness: 5, confidence: 5 }),
      session(ago(2), { pain: 3, stiffness: 5, confidence: 5 }),
    ];
    return withSeededSessions(sessions, (items) => {
      const trends = computeTrend(items, AS_OF);
      const by = Object.fromEntries(trends.map((t) => [t.metric, t]));
      assert.equal(by.painRating.direction, "improving", `pain ${by.painRating.direction}`);
      assert.equal(by.stiffnessRating.direction, "worsening", `stiffness ${by.stiffnessRating.direction}`);
      assert.equal(by.confidenceRating.direction, "plateauing", `confidence ${by.confidenceRating.direction}`);
      console.log("       --- trend narratives ---");
      for (const t of trends) console.log(`       [${t.direction}] ${t.narrative}`);
      return `pain=${by.painRating.direction}, stiffness=${by.stiffnessRating.direction}, confidence=${by.confidenceRating.direction}`;
    });
  });

  // --- (f) Trend insufficient_data: empty prior window ---
  await check("(f) trend insufficient_data (empty prior window)", async () => {
    const sessions = [session(ago(1), { pain: 3, stiffness: 3, confidence: 4 })];
    return withSeededSessions(sessions, (items) => {
      const trends = computeTrend(items, AS_OF);
      for (const t of trends) {
        assert.equal(t.direction, "insufficient_data", `${t.metric} ${t.direction}`);
      }
      return "all three metrics insufficient_data";
    });
  });

  // --- Final: Sessions pristine after every case ---
  await check("Sessions pristine after all cases (Count===0)", async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: SESSIONS_TABLE,
        KeyConditionExpression: "PK = :p",
        ExpressionAttributeValues: { ":p": SESSION_PK },
        Select: "COUNT",
      })
    );
    assert.equal(res.Count, 0, `expected 0 sessions, got ${res.Count}`);
    return "Count=0";
  });
}

run()
  .then(() => {
    console.log("");
    if (failures > 0) {
      console.log(`RESULT: ${failures} case(s) FAILED`);
      process.exit(1);
    }
    console.log("RESULT: all cases PASSED");
  })
  .catch((err) => {
    console.error("❌ verify harness error:", err);
    process.exit(1);
  });
