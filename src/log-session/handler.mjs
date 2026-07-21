// Phase 4 — log-session endpoint (Lambda Function URL, payload format v2.0).
//
// Persists one real session into rehab-sessions and enriches each per-side
// free-text note with tags by invoking the existing rehab-tagging Lambda
// (Lambda-to-Lambda). This function NEVER re-implements the Bedrock call — it
// delegates classification to the tagging Lambda and stores its 3-key output.
//
// Input body (JSON):
//   { sessionDate, completedExercises: [ { exerciseId,
//       sides: { left|right|n-a: { completed, rawNote } } } ],
//     painRating, stiffnessRating, confidenceRating }
//
// AUTH: Function URL is AuthType NONE at the infra level; a shared-secret
// header (x-api-key) is checked HERE, before any other processing.

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { ddb, SESSIONS_TABLE, SESSION_PK, REGION } from "../lib/ddb.mjs";

const SESSION_LOG_SECRET = process.env.SESSION_LOG_SECRET;
const TAGGING_FUNCTION = process.env.TAGGING_FUNCTION || "rehab-tagging";

const VALID_SIDES = new Set(["left", "right", "n-a"]);
const RATING_KEYS = ["painRating", "stiffnessRating", "confidenceRating"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const lambda = new LambdaClient({ region: REGION });

// Constant-time secret compare that also tolerates length differences: hash
// both sides to a fixed 32 bytes first, so timingSafeEqual never throws and the
// comparison time does not depend on where the mismatch is.
function secretMatches(provided) {
  if (typeof provided !== "string" || typeof SESSION_LOG_SECRET !== "string") {
    return false;
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(SESSION_LOG_SECRET).digest();
  return timingSafeEqual(a, b);
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

// A valid YYYY-MM-DD that is also a real calendar date (rejects 2026-13-40).
function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

// Fail-loud validation. Returns an error string, or null when the payload is
// well-formed. No silent coercion of bad input (Phase 2 discipline).
function validate(payload) {
  if (!payload || typeof payload !== "object") return "body must be a JSON object";

  if (!isValidDateStr(payload.sessionDate)) {
    return "sessionDate must be a valid YYYY-MM-DD string";
  }

  const exercises = payload.completedExercises;
  if (!Array.isArray(exercises) || exercises.length === 0) {
    return "completedExercises must be a non-empty array";
  }

  for (const ex of exercises) {
    if (!ex || !isNonEmptyString(ex.exerciseId)) {
      return "each completedExercises entry needs a non-empty exerciseId";
    }
    if (!ex.sides || typeof ex.sides !== "object") {
      return `exercise ${ex.exerciseId}: sides must be an object`;
    }
    for (const [side, sideObj] of Object.entries(ex.sides)) {
      if (!VALID_SIDES.has(side)) {
        return `exercise ${ex.exerciseId}: invalid side "${side}" (expected left|right|n-a)`;
      }
      if (!sideObj || typeof sideObj !== "object") {
        return `exercise ${ex.exerciseId} side ${side}: must be an object`;
      }
      if (typeof sideObj.completed !== "boolean") {
        return `exercise ${ex.exerciseId} side ${side}: completed must be a boolean`;
      }
      if (sideObj.rawNote !== undefined && typeof sideObj.rawNote !== "string") {
        return `exercise ${ex.exerciseId} side ${side}: rawNote must be a string`;
      }
    }
  }

  for (const key of RATING_KEYS) {
    const v = payload[key];
    if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 10) {
      return `${key} must be a number between 0 and 10`;
    }
  }

  return null;
}

// Invoke the tagging Lambda for one side's note and return its 3-key output.
async function tagNote(exerciseId, side, rawNote) {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: TAGGING_FUNCTION,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ exerciseId, side, rawNote })),
    })
  );
  const parsed = JSON.parse(Buffer.from(res.Payload).toString("utf8"));
  // A thrown error inside the tagging Lambda surfaces as FunctionError; fail
  // loud rather than storing a malformed tag.
  if (res.FunctionError) {
    throw new Error(
      `tagging Lambda error for ${exerciseId}/${side}: ${parsed?.errorMessage || res.FunctionError}`
    );
  }
  const { symptomType, severity, flagForReview } = parsed;
  return { symptomType, severity, flagForReview };
}

export const handler = async (event = {}) => {
  // --- AUTH FIRST: before parsing, validating, anything. Generic 401 that does
  // not reveal whether the key was missing vs wrong. ---
  const headers = event.headers || {};
  const provided = headers["x-api-key"]; // Function URL v2 lowercases header keys
  if (!secretMatches(provided)) {
    return json(401, { error: "unauthorized" });
  }

  // --- Parse body (Function URL may base64-encode it) ---
  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be valid JSON" });
  }

  // --- Fail-loud validation ---
  const error = validate(payload);
  if (error) return json(400, { error });

  // --- Tag each side that carries a note; empty note => empty tags, no call ---
  const completedExercises = [];
  for (const ex of payload.completedExercises) {
    const sides = {};
    for (const [side, sideObj] of Object.entries(ex.sides)) {
      const rawNote = sideObj.rawNote ?? "";
      let tags = [];
      if (isNonEmptyString(rawNote)) {
        tags = [await tagNote(ex.exerciseId, side, rawNote)];
      }
      sides[side] = { completed: sideObj.completed, rawNote, tags };
    }
    completedExercises.push({ exerciseId: ex.exerciseId, sides });
  }

  // --- Assemble the full Session item (Phase 1 schema) and persist ---
  const item = {
    PK: SESSION_PK,
    SK: payload.sessionDate,
    sessionDate: payload.sessionDate,
    sessionId: randomUUID(),
    completedExercises,
    painRating: payload.painRating,
    stiffnessRating: payload.stiffnessRating,
    confidenceRating: payload.confidenceRating,
    loggedAt: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: item }));

  return json(200, { ok: true, item });
};
