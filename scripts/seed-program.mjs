// Seed the Program table with the 9 prescribed exercises from data/program-seed.json.
// Validates invariants before any write, then loads in a single BatchWrite.
// Idempotent by key (Put overwrites). Run: node scripts/seed-program.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, PROGRAM_TABLE, PROGRAM_PK } from "./lib/ddb.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "..", "data", "program-seed.json");

function validate(items) {
  const errors = [];
  if (!Array.isArray(items)) errors.push("seed file is not a JSON array");
  if (items.length !== 9) errors.push(`expected exactly 9 items, got ${items.length}`);

  const ids = new Set();
  for (const [i, it] of items.entries()) {
    const at = `item[${i}] (${it?.SK ?? "?"})`;
    if (it?.PK !== PROGRAM_PK) errors.push(`${at}: PK must be "${PROGRAM_PK}"`);
    if (!it?.SK || typeof it.SK !== "string") errors.push(`${at}: SK (exerciseId) missing/not a string`);
    if (it?.exerciseId !== it?.SK) errors.push(`${at}: exerciseId must equal SK`);
    if (it?.status !== "active") errors.push(`${at}: status must be "active" at seed time`);
    if (!Array.isArray(it?.versionHistory) || it.versionHistory.length !== 0)
      errors.push(`${at}: versionHistory must be an empty list at seed time`);
    for (const f of ["name", "section", "targetSets", "targetReps", "cues"]) {
      if (typeof it?.[f] !== "string" || it[f].length === 0) errors.push(`${at}: ${f} missing/not a non-empty string`);
    }
    if (typeof it?.perSide !== "boolean") errors.push(`${at}: perSide must be a boolean`);
    if (it?.SK) {
      if (ids.has(it.SK)) errors.push(`${at}: duplicate exerciseId`);
      ids.add(it.SK);
    }
  }

  if (errors.length) {
    console.error("❌ Seed validation failed:");
    for (const e of errors) console.error("   - " + e);
    process.exit(1);
  }
}

async function batchWriteAll(items) {
  // 9 items is well under the 25-item BatchWrite limit -> single request,
  // but loop on UnprocessedItems with backoff for correctness.
  let requestItems = {
    [PROGRAM_TABLE]: items.map((Item) => ({ PutRequest: { Item } })),
  };
  let attempt = 0;
  while (requestItems && Object.keys(requestItems).length > 0) {
    const res = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
    const unprocessed = res.UnprocessedItems || {};
    if (Object.keys(unprocessed).length === 0) return;
    attempt += 1;
    if (attempt > 5) throw new Error("BatchWrite still has UnprocessedItems after 5 retries");
    await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    requestItems = unprocessed;
  }
}

async function main() {
  const raw = await readFile(SEED_PATH, "utf8");
  const items = JSON.parse(raw);
  validate(items);
  await batchWriteAll(items);
  console.log(`Seeded ${items.length}/9 Program items into ${PROGRAM_TABLE}`);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
