// Shared DynamoDB DocumentClient factory + resolved table names / key constants.
// Reused by the seed script, the verify script, and Phase 2+ compute.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const REGION = process.env.AWS_REGION || "us-east-1";

// Table names resolve from env (set as Lambda env vars in Phase 2) or fall back
// to the physical names defined in infra/data-stack.yaml.
export const PROGRAM_TABLE = process.env.PROGRAM_TABLE || "rehab-program";
export const SESSIONS_TABLE = process.env.SESSIONS_TABLE || "rehab-sessions";

// Fixed single-partition keys.
export const PROGRAM_PK = "PROGRAM";
export const SESSION_PK = "SESSION";

// Raw low-level client — needed for control-plane commands like DescribeTable
// that the DocumentClient does not wrap.
export const raw = new DynamoDBClient({ region: REGION });

// removeUndefinedValues keeps sparse items clean (omitted attrs, not null).
export const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});
