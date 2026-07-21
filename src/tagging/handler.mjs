// Phase 2 — Bedrock tagging Lambda.
//
// Input event:  { exerciseId, side, rawNote }   (side ∈ left | right | n-a)
// Output:       { symptomType, severity, flagForReview }
//
// The function CLASSIFIES only (Bedrock does judgment). It fetches the exercise's
// prescribed cues from the Program table, forces a single-tool Bedrock response so
// no free text / advice can appear, then applies a deterministic flag backstop.
// See src/tagging/prompt.mjs for the boundary language and tool schema.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  TOOL_NAME,
  TOOL_CONFIG,
  SYSTEM_PROMPT,
  SYMPTOM_TYPES,
  SEVERITIES,
  FLAG_KEYWORDS,
  buildUserMessage,
} from "./prompt.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const PROGRAM_TABLE = process.env.PROGRAM_TABLE || "rehab-program";
const PROGRAM_PK = "PROGRAM";
// On-demand inference profile for Nova Lite in us-east-1 (proven ACTIVE in Phase 0).
const MODEL_ID = process.env.MODEL_ID || "us.amazon.nova-lite-v1:0";

const VALID_SIDES = new Set(["left", "right", "n-a"]);

// Clients are created once per container (reused across warm invocations).
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const bedrock = new BedrockRuntimeClient({ region: REGION });

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

export const handler = async (event = {}) => {
  const { exerciseId, side, rawNote } = event;

  // --- Input validation: fail loud, with distinct identifiable errors ---
  if (!isNonEmptyString(exerciseId)) {
    throw new Error("exerciseId missing from event");
  }
  if (!VALID_SIDES.has(side)) {
    throw new Error(`invalid side: ${JSON.stringify(side)} (expected left|right|n-a)`);
  }

  // --- Empty-note short-circuit: no symptom to classify, skip Bedrock entirely ---
  if (!isNonEmptyString(rawNote)) {
    return { symptomType: "none", severity: "none", flagForReview: false };
  }

  // --- Fetch the exercise's prescribed cues from the Program table ---
  const { Item: exercise } = await ddb.send(
    new GetCommand({
      TableName: PROGRAM_TABLE,
      Key: { PK: PROGRAM_PK, SK: exerciseId },
    })
  );
  if (!exercise) {
    throw new Error(`exerciseId not found in Program table: ${exerciseId}`);
  }

  // --- Bedrock: forced single-tool classification (judgment step) ---
  const { symptomType, severity } = await classify({
    name: exercise.name,
    cues: exercise.cues,
    side,
    rawNote,
  });

  // --- Deterministic post-processing (math step): flag backstop ---
  const flagForReview = computeFlag(severity, rawNote);

  return { symptomType, severity, flagForReview };
};

// Invoke Nova Lite via Converse with a forced tool call, and extract the two
// classified fields from the toolUse block. Coerce any off-schema value to a safe
// in-enum default rather than trusting the model blindly.
async function classify({ name, cues, side, rawNote }) {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage({ name, cues, side, rawNote }) }],
      toolConfig: TOOL_CONFIG,
      inferenceConfig: { temperature: 0, maxTokens: 256 },
    })
  );

  const content = res.output?.message?.content ?? [];
  const toolUse = content.find((b) => b.toolUse?.name === TOOL_NAME)?.toolUse;
  if (!toolUse?.input) {
    // Structurally unexpected — the forced tool did not come back. Fail loud so it
    // surfaces in the test harness rather than silently degrading.
    throw new Error(
      `model did not return a ${TOOL_NAME} tool call (stopReason=${res.stopReason})`
    );
  }

  const symptomType = coerceEnum(toolUse.input.symptomType, SYMPTOM_TYPES, "other", "symptomType");
  const severity = coerceEnum(toolUse.input.severity, SEVERITIES, "none", "severity");
  return { symptomType, severity };
}

// Keep the returned value strictly in-enum; log and fall back if the model drifts.
function coerceEnum(value, allowed, fallback, field) {
  if (allowed.includes(value)) return value;
  console.warn(`off-schema ${field}=${JSON.stringify(value)} → coerced to '${fallback}'`);
  return fallback;
}

// flagForReview = moderate/severe severity, OR a case-insensitive keyword hit in
// the raw note (the backstop fires even if the model under-classified severity).
function computeFlag(severity, rawNote) {
  if (severity === "moderate" || severity === "severe") return true;
  const lower = rawNote.toLowerCase();
  return FLAG_KEYWORDS.some((kw) => lower.includes(kw));
}
