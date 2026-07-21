// Shared DynamoDB DocumentClient factory + resolved table names / key constants
// for Phase 4 compute Lambdas (log-session, nudge, digest). Mirrors the dev-side
// scripts/lib/ddb.mjs, but lives under src/ so bundled Lambda code imports it
// without crossing the src/scripts boundary.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const REGION = process.env.AWS_REGION || "us-east-1";

// Table names resolve from env (set as Lambda env vars) or fall back to the
// physical names defined in infra/data-stack.yaml.
export const PROGRAM_TABLE = process.env.PROGRAM_TABLE || "rehab-program";
export const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "rehab-sessions";

// Fixed single-partition keys.
export const PROGRAM_PK = "PROGRAM";
export const SESSION_PK = "SESSION";

// removeUndefinedValues keeps sparse items clean (omitted attrs, not null).
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);
