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

// Reserved date namespace for TEST writes to the Sessions table.
//
// Real sessions are keyed by their real calendar date (SK = "YYYY-MM-DD"), and a
// second PutItem on an existing date is a full-item OVERWRITE, not a merge — so
// any harness that seeds synthetic sessions and deletes them in a `finally` will
// silently destroy a real session if its date collides. (This is exactly the
// class of mistake that overwrote a real 2026-07-21 session in Phase 5 Part B;
// PITR recovered it, but the primary guard is to never write a test row to a
// date that could hold real data.)
//
// The logic layer is pure and clock-free, so an absolute anchor in the year 2000
// behaves identically to "today" for every window calculation — only the
// absolute SK changes, moving all test rows into a namespace that no real
// session (this tool began in 2026) will ever occupy. Mid-year so ±180 days of
// offset math stays inside the reserved year.
export const TEST_ONLY_DATE = "2000-06-15";

// Inclusive SK range covering the whole reserved test year. Cleanup and the
// post-test "pristine" assertion scope to THIS range, never the whole partition
// (which may legitimately hold real sessions).
export const TEST_ONLY_RANGE = { start: "2000-01-01", end: "2000-12-31" };

// Raw low-level client — needed for control-plane commands like DescribeTable
// that the DocumentClient does not wrap.
export const raw = new DynamoDBClient({ region: REGION });

// removeUndefinedValues keeps sparse items clean (omitted attrs, not null).
export const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});
