# PROJECT_STATUS.md — Recovery Adherence & Asymmetry Watcher

Running log: phase-by-phase findings, environment details, and decision log.
CLAUDE.md holds the spec + boundary; this file holds the state. Keep phase findings here.

---

## Environment (confirmed 2026-07-20, Phase 0)

| Item | Value |
|------|-------|
| AWS account | `790561527138` |
| IAM principal | `arn:aws:iam::790561527138:user/Marv` |
| Region | `us-east-1` (from CLI config; no `AWS_REGION`/`AWS_DEFAULT_REGION` env override) |
| AWS CLI | `aws-cli/2.35.21` (Python 3.14.6, Darwin/x86_64) |
| Node (local) | `v24.11.1` — **dev only, NOT the deploy target** |
| npm | `11.6.2` |
| Lambda runtime target | `nodejs22.x` (newest managed runtime; there is no node24 Lambda runtime) |
| esbuild | `0.28.1` |

---

## Phase 0 — Environment check ✅ COMPLETE (2026-07-20)

Every item proven by a live test, not assumed.

### 1. AWS CLI identity — ✅ PASS
`aws sts get-caller-identity` → `user/Marv`, account `790561527138`.

### 2. IAM permissions — ✅ PASS (verified via `iam simulate-principal-policy`, not attachment inspection)
All actions returned **allowed**:
- **Lambda:** CreateFunction, InvokeFunction, UpdateFunctionCode, AddPermission
- **DynamoDB:** CreateTable, PutItem, GetItem, Query
- **EventBridge Scheduler:** CreateSchedule, GetSchedule
- **Bedrock:** InvokeModel, ListFoundationModels, GetFoundationModelAvailability
- **IAM:** CreateRole, AttachRolePolicy, PutRolePolicy, PassRole
- **CloudFormation:** CreateStack, CreateChangeSet, ExecuteChangeSet
- **SES:** SendEmail, SendRawEmail, VerifyEmailIdentity, GetAccount

### 3. Bedrock Nova Lite invokable — ✅ PASS (actually invoked, not just "enabled")
Live `bedrock-runtime invoke-model` returned `"OK"` via **both**:
- Inference profile `us.amazon.nova-lite-v1:0` (status ACTIVE) — the on-demand path in us-east-1
- Direct model id `amazon.nova-lite-v1:0`

Available Nova model ids in-region include: `amazon.nova-lite-v1:0` (+ `:24k`, `:300k` context variants), `amazon.nova-pro-v1:0`, `amazon.nova-2-multimodal-embeddings-v1:0`.
Default model per CLAUDE.md: **Nova Lite**.

### 4. Node.js / npm — ✅ suitable for dev, with enforced deploy target
Local node v24.11.1 / npm 11.6.2 are fine for development. Lambda's newest managed runtime is
`nodejs22.x`, so the deploy target is pinned to node22 regardless of local version.
See **Decision Log D-2** and the build verification below.

### 5. Infra tooling — ✅ CONFIRMED: raw CloudFormation only
All infrastructure via `aws cloudformation package` → `deploy`. **No SAM. No Amplify CLI**
(frontend phase may revisit its own tooling later, but not Amplify CLI for infra).

### 6. Repo hygiene — ✅ FIXED
Repo cloned, branch `main`. `.gitignore` was missing at Phase 0 start — created, covering
`node_modules/`, `.env`/`.env.*`, build artifacts (`dist/`, `build/`, `*.zip`, `.aws-sam/`,
`cdk.out/`), logs, and OS cruft. Nothing committed yet (not requested).

### 7. node22 build verification — ✅ PASS (real build, not config-only)
esbuild `0.28.1` bundled a sample handler using ES2022/2023 features (optional chaining,
nullish coalescing, `Array.prototype.findLast`, `Object.hasOwn`, `structuredClone`, object spread):

```
npx esbuild src/handler.mjs --bundle --platform=node --format=cjs --target=node22 --outfile=dist/handler.cjs
```

- Build exit 0, 1.3kb output.
- Bundle **ran correctly** under node: `handler({notes:[{side:'left'},{side:'right'}]})`
  → `{"statusCode":200,"last":{"side":"left"},"has":true}`.
- Syntax scan for node24-only constructs (`using`/`await using`, `Array.fromAsync`) → **none found**.
- Note for Phase 1: emit CJS Lambda bundles with a `.cjs` extension (or ship a deploy-artifact
  `package.json` without `"type":"module"`) so node resolves the CJS `module.exports` handler.

### 8. SES usability — ✅ SANDBOX, single identity verified
Checked live via `sesv2 get-account` / `list-email-identities`:
- **`ProductionAccessEnabled: False` → account is in the SES sandbox.**
- `SendingEnabled: True`, `EnforcementStatus: HEALTHY`, quota 200 sends/24h, 0 sent.
- Verified identities at Phase 0 start: **none**.

**Consequence of sandbox:** both sender AND every recipient must be verified identities before
any mail sends. Since this is a single-user personal tool (the "therapist-ready summary" is
formatted for Marvin to bring to his own appointment — not an automated send-to-therapist),
the plan is a single self-verified identity, **no production-access request needed**.

**Action taken:** verified `marvin.ngonadi@gmail.com` (sender = recipient) via
`sesv2 create-email-identity`, confirmed by clicking the AWS email. Re-checked with
`sesv2 get-email-identity` → **`VerifiedForSendingStatus: True`** ✅ (DKIM NOT_STARTED — not
needed for sandbox email-address identity). This is the one verified identity; in sandbox all
sends must be to/from it, which matches the single-user design.

---

## Phase 1 — Data layer ✅ COMPLETE (2026-07-20)

Every item proven by a live test against the deployed tables, not assumed.

**Deployed:** CloudFormation stack `rehab-data` (`infra/data-stack.yaml`) → `CREATE_COMPLETE`.
Two DynamoDB tables, both on-demand, PITR + deletion protection, **no GSIs**:

| Table | PK (fixed) | SK | Billing | PITR | DeletionProtection | GSIs |
|-------|-----------|----|---------|------|--------------------|------|
| `rehab-program` | `"PROGRAM"` | exerciseId | PAY_PER_REQUEST | ENABLED | True | None |
| `rehab-sessions` | `"SESSION"` | session date (ISO-8601) | PAY_PER_REQUEST | ENABLED | True | None |

Stack Outputs exported for Phase 2 `Fn::ImportValue`: `rehab-program-table-name`,
`rehab-sessions-table-name`, `rehab-program-table-arn`, `rehab-sessions-table-arn`.

**Deploy command (no `package` step — see D-7):**
```
aws cloudformation deploy --template-file infra/data-stack.yaml \
  --stack-name rehab-data --region us-east-1 --no-fail-on-empty-changeset
```

### 1. Both tables ACTIVE — ✅ PASS
`describe-table` on each → `TableStatus: ACTIVE`. Independent CLI + verify-script check agree.

### 2. Program: 9 items readable & correctly shaped — ✅ PASS
`node scripts/seed-program.mjs` → `Seeded 9/9 Program items`. Query `PK="PROGRAM"` → `Count=9`;
every item `status="active"`, `versionHistory=[]`, `exerciseId===SK`, `perSide` boolean, all
required fields present. `targetSets`/`targetReps` stored as **verbatim strings** (e.g. `"2-3"`,
`"30s/side"`, `"8-10 reps/side"`) — the prescription uses ranges and time-holds that don't fit a
number. CLI `--select COUNT` → `9`. Sample item (`single_leg_squat_step_down`) confirmed correct
types via `get-item`: `perSide {BOOL:true}`, `versionHistory {L:[]}`, optional fields
(`retiredDate` etc.) sparsely omitted.

### 3. Sessions nested round-trip (maps/lists/bools) — ✅ PASS
`Put` a fully-populated session (`completedExercises` list → maps → `sides.{left,right}.{completed,
rawNote,tags}`), `Get` by key, `assert.deepStrictEqual` on the whole item → match. Proves nested
maps, lists, and booleans round-trip cleanly through the DocumentClient.

### 4. Most recent session (`ScanIndexForward:false, Limit:1`) — ✅ PASS
Query `PK="SESSION"` descending, `Limit:1` → returned the latest-dated synthetic row (`2026-07-20`).

### 5. Last-7-days range query (`BETWEEN`) — ✅ PASS
Query `PK="SESSION" AND SK BETWEEN :start AND :end` (window `2026-07-14`..`2026-07-20`) → 3 in-window
rows (`2026-07-14, 2026-07-17, 2026-07-20`); a negative-control row dated `2026-07-10` (10 days back)
was correctly **excluded**. ISO `YYYY-MM-DD` sorts lexicographically = chronologically, so `BETWEEN`
is a valid date range.

### 6. Sessions pristine after cleanup (`Count===0`) — ✅ PASS
Synthetic-row cleanup runs in a `finally` block (executes even if checks 3–5 throw). After cleanup,
Query `PK="SESSION"` → `Count=0`. This is explicit proof the table is empty, not an assumption the
deletes succeeded. Real logging starts from zero.

**Verify harness output** (`node scripts/verify-data.mjs`):
```
✅ PASS — both tables ACTIVE: {"rehab-program":"ACTIVE","rehab-sessions":"ACTIVE"}
✅ PASS — Program: 9 items readable & correctly shaped: Count=9, all active, versionHistory=[]
✅ PASS — Sessions nested round-trip (maps/lists/bools): deep-equal on 2026-07-20 (sessionId=verify-roundtrip)
✅ PASS — most recent session (ScanIndexForward:false, Limit:1): latest = 2026-07-20
✅ PASS — last-7-days range query (BETWEEN): window 2026-07-14..2026-07-20 returned 3 rows: 2026-07-14, 2026-07-17, 2026-07-20
✅ PASS — Sessions pristine after cleanup (Count===0): Count=0

RESULT: all 6 checks PASSED
```

### Artifacts added this phase
- `infra/data-stack.yaml` — the two-table CloudFormation template (no GSIs).
- `data/program-seed.json` — the 9 prescribed exercises, verbatim.
- `scripts/lib/ddb.mjs` — shared DocumentClient + table-name/PK constants (reused in Phase 2).
- `scripts/seed-program.mjs` — validates invariants (9 items, all active, empty history) then BatchWrites.
- `scripts/verify-data.mjs` — the 6 live checks above.
- `package.json` — deps `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (both `3.1091.0`). ESM
  `.mjs` dev scripts; `package.json` deliberately omits `"type":"module"` so it doesn't collide with
  the Phase 0 note that Lambda **deploy artifacts** ship CJS (D from Phase 0 §7).

---

## Decision Log

- **D-1 (2026-07-20):** Infra is raw CloudFormation, no SAM/Amplify CLI. Rationale: SAM
  `CreateChangeSet`/transform permission failures burned time on the prior project; CLAUDE.md
  mandates the proven `package`→`deploy` path.
- **D-2 (2026-07-20):** Lambda deploy target pinned to `nodejs22.x`; bundler explicitly targets
  node22. Local node (v24) is not the deploy target. Verified by real esbuild build (§7).
- **D-3 (2026-07-20):** Delivery is **both** channels. Email (SES) = proactive push (daily
  missed-session nudge, weekly therapist-ready summary, no login). Frontend = on-demand deep
  view (trends, session-by-session comparison vs prior workouts, detail behind the summary).
- **D-4 (2026-07-20):** SES stays in **sandbox**; single self-verified identity
  `marvin.ngonadi@gmail.com` as both sender and recipient. No production-access request —
  this is a personal single-user tool; "therapist-ready" means formatted for Marvin to share
  himself, not an automated third-party send.
- **D-5 (2026-07-20):** `Program` table redesigned from a static one-time load to a
  versioned/status-tracked design (`status`: active/retired, `versionHistory`,
  `retiredDate`/`retiredReason`, `progressedTo`/`progressedFrom`). Rationale: needed to support
  real-world program changes — a new program from the physio, a single exercise progressing, or a
  mid-program addition — without losing history. Changes are applied **manually**, not
  auto-detected; adherence/asymmetry logic filters on `status = active` for "the current program."
- **D-6 (2026-07-20):** Reporting boundary extended to **weekly AND monthly** summaries. The
  monthly view may narrate trends (improving, plateauing, worsening) and prompt a physio
  conversation, but reports the pattern only — never diagnoses or explains cause. Rationale: trend
  narration was identified as the point most likely to blur the clinical boundary, so the rule was
  made explicit rather than assumed covered by the original core boundary.
- **D-7 (2026-07-20):** Skipped `aws cloudformation package` for the data stack; deployed the raw
  template directly with `aws cloudformation deploy`. Rationale: the template has zero local
  artifacts (no Lambda `CodeUri`, no nested stacks), so `package` is a provable no-op that would only
  demand an empty S3 upload. **Not a deviation** from the locked package→deploy path — `package`
  returns in Phase 2 when Lambda bundles genuinely need uploading.
- **D-8 (2026-07-20):** Table modelling choices, all applied to **both** tables: generic `PK`/`SK`
  key attribute names (with the semantic value duplicated as `exerciseId`/`sessionDate` so items are
  self-describing and one query/marshalling helper serves both tables); `BillingMode
  PAY_PER_REQUEST` (single-user, spiky traffic, $0 idle); PITR + `DeletionProtectionEnabled` +
  `DeletionPolicy/UpdateReplacePolicy: Retain` (Sessions holds permanently-kept raw notes;
  uniformity keeps the template symmetric). `targetSets`/`targetReps` stored as **verbatim strings**,
  not numbers — the real prescription uses ranges and time-holds. **No GSIs** on either table, per the
  locked spec.
- **D-9 (2026-07-20):** Explicit physical names (`rehab-program`, `rehab-sessions`), stack
  `rehab-data`, `rehab-` prefix chosen by Marvin. Names AND ARNs surfaced as CloudFormation Outputs
  with `Export` so the Phase 2 compute stack can `Fn::ImportValue` them and Lambdas receive names as
  env vars (`PROGRAM_TABLE`, `SESSIONS_TABLE`). Rationale: stable, predictable references for Phase 2
  instead of CloudFormation's auto-generated names.

### Teardown note (recorded, not acted on)
`DeletionProtectionEnabled: true` + `DeletionPolicy: Retain` mean deleting `rehab-data` first requires
`aws dynamodb update-table --no-deletion-protection-enabled` on each table, and even then the Retain
policy **orphans** (does not delete) the tables — intentional for the permanent Sessions data.

---

## Next: Phase 2
**Phase 1 fully closed (2026-07-20).** Both tables live and ACTIVE, 9-exercise program seeded, all 6
data-layer checks pass against the deployed tables. Data layer is verified and stable for the Bedrock
tagging pipeline and Lambda adherence/asymmetry logic to build on.
