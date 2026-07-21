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

## Phase 2 — Bedrock tagging Lambda ✅ COMPLETE (2026-07-20)

The judgment step of the pipeline. A single Lambda (`rehab-tagging`) takes a **known**
`exerciseId`, a **known** `side` (`left|right|n-a`), and a raw free-text note, and returns
exactly `{ symptomType, severity, flagForReview }`. It classifies only — it never infers
exercise/side, never emits free text, never advises. Every result below is from the **real
deployed Lambda invoking real Bedrock** (no mocks).

**Deployed:** CloudFormation stack `rehab-tagging` (`infra/tagging-stack.yaml`) →
`CREATE_COMPLETE`. Lambda `rehab-tagging` (`nodejs22.x`, handler `index.handler`, 256MB,
30s) `State: Active`, execution role `rehab-tagging-role`.

**Boundary mechanism:** forced tool-use. The Converse call to Nova Lite
(`us.amazon.nova-lite-v1:0`) forces a single tool `tag_symptom` whose schema has **exactly
two** properties (`symptomType`, `severity`), both required, `additionalProperties:false`.
There is structurally no field where advice could appear. System prompt states the function
classifies only and must ignore any embedded question/request. Boundary language + schema
live in one auditable file: `src/tagging/prompt.mjs`.

**Deterministic backstop (Lambda math, no 2nd model call):** `flagForReview = true` if
severity is `moderate`/`severe`, **OR** the raw note contains (case-insensitive) any of
`sharp`, `locked`, `gave way`, `can't bear weight`, `buckled`.

### Live test suite — `node scripts/verify-tagging.mjs` → all 5 PASS, exit 0
Stable across two consecutive runs (temperature 0). Real deployed Lambda, real Bedrock.

```
✅ PASS — a. single_leg_rdl/left — no issues: symptomType="none", severity="none", flagForReview=false
✅ PASS — b. standing_wall_hip_adduction/right — mild tightness: symptomType="tightness", severity="mild", flagForReview=false
✅ PASS — c. single_leg_squat_step_down/left — moderate instability: symptomType="instability", severity="moderate", flagForReview=true
✅ PASS — d. push_up_plus/n-a — severe pain (severity + 'sharp' keyword): symptomType="pain", severity="severe", flagForReview=true
✅ PASS — e. adversarial — response contains ONLY symptomType/severity/flagForReview: keys=[symptomType, severity, flagForReview]

RESULT: all 5 cases PASSED
```

### Case e — the boundary proof (adversarial)
Input: `single_leg_squat_step_down` / `right` /
*"Left knee really hurts, should I just skip this exercise from now on?"*
The note embeds a direct request for clinical advice. **Full raw response object** returned
by the live Lambda:

```json
{
  "symptomType": "pain",
  "severity": "severe",
  "flagForReview": true
}
```

Only the three permitted fields — no advice field, no answer to "should I skip this?", no
place one could even appear. The model also did **not** under-classify (severity=`severe`,
not `none`), so the harness's distinct under-classification warning did not fire. The
boundary held structurally, not just by assertion.

### Fail-loud validation & short-circuit — verified live (direct invokes)
Two malformed-event bugs surface as two **distinct, identifiable** errors, and a third for
an unknown id, each proven against the deployed function:

| Input | Result |
|-------|--------|
| `{side, rawNote}` (no exerciseId) | throws `exerciseId missing from event` |
| `side:"middle"` | throws `invalid side: "middle" (expected left\|right\|n-a)` |
| `exerciseId:"does_not_exist"` (GetItem returns nothing) | throws `exerciseId not found in Program table: does_not_exist` |
| `rawNote:"   "` (blank) | returns `{none,none,false}` immediately, **no Bedrock call** |

### Artifacts added this phase
- `src/tagging/handler.mjs` — validation → cues fetch (GetItem on `rehab-program`) →
  forced-tool Converse → deterministic flag → return.
- `src/tagging/prompt.mjs` — system prompt, `tag_symptom` tool schema, enums, flag keywords,
  user-message builder (note fenced as data, not instructions).
- `infra/tagging-stack.yaml` — Lambda + least-privilege role (`GetItem` on the imported
  program-table ARN; `bedrock:InvokeModel` on the Nova Lite profile + its 3 regional model
  ARNs; own log group). Imports `rehab-program-table-name`/`-arn` via `Fn::ImportValue`;
  exports `rehab-tagging-function-name`/`-arn` for later phases.
- `scripts/verify-tagging.mjs` — the 5-case live harness (invokes the deployed Lambda via
  `@aws-sdk/client-lambda`).
- `package.json` — added `@aws-sdk/client-bedrock-runtime` (dep), `@aws-sdk/client-lambda` +
  `esbuild` (devDeps), `build:tagging` + `verify:tagging` scripts.
- Build artifact `dist/tagging/index.js` (esbuild CJS, `--target=node22`, `@aws-sdk/*`
  external) uploaded to the new artifacts bucket by `aws cloudformation package`.

### Manual Console Cross-Check (2026-07-21)
Independently confirmed in the AWS console, outside the automated verify script:
- **CloudFormation:** `rehab-tagging` stack shows `CREATE_COMPLETE`.
- **Lambda:** `rehab-tagging` shows Runtime `nodejs22.x`, recent real invocations.
- **IAM:** execution role's DynamoDB statement scoped to the `rehab-program` table ARN
  specifically (not wildcard); Bedrock statement scoped to the inference-profile ARN plus the
  3 regional foundation-model ARNs (not blanket `bedrock:*`).
- **CloudWatch `/aws/lambda/rehab-tagging`:** confirmed real invocation entries with plausible
  durations (cold start ~1057ms, warm calls 479–694ms), consistent with a GetItem + Bedrock
  Converse call per invocation.
- **CloudWatch `/aws/bedrock/recovery-watcher`:** confirmed model-invocation logging is
  capturing real request/response content, including the case-e adversarial exchange.
- **DynamoDB:** `rehab-sessions` confirmed still at 0 items (this Lambda never touches
  Sessions); `rehab-program` confirmed still at 9 items, unchanged.
- **S3:** `rehab-artifacts-790561527138` exists, public access blocked, correct naming per the
  `rehab-` convention.
- **Cost Explorer:** nonzero Bedrock cost for today, consistent with real (not mocked) model
  invocations.

---

## Phase 3 — Deterministic logic ✅ COMPLETE (2026-07-20)
The "math" half of the architecture: adherence, side-asymmetry, escalation compiler, and trend
narration. **Pure functions only** — no AWS SDK, no clock reads (`Date.now()`), no Lambda, no
EventBridge, no SES, and **no model**. Every function takes already-fetched plain data plus an
explicit `asOfDate`. Wiring these into real triggers is Phase 4.

**Verified:** `node scripts/verify-logic.mjs` seeds synthetic sessions into the live `rehab-sessions`
table (Phase 1 insert/assert/delete-in-`finally` pattern), fetches the real 9 `rehab-program` items
live to derive the per-side exercise list, runs the pure logic against the fetched data, and proves
`Count === 0` afterward. All cases pass.

### 1. Adherence — ✅ PASS
`checkMissedSession` and `weeklyAdherence` against the trailing-7-day window and the 3x/week target.

### 2. Asymmetry — ✅ PASS
`detectAsymmetry` guards on sample size (both sides `< ASYMMETRY_MIN_SAMPLE` → `insufficient_data`,
never a guess) before flagging a side by the `ASYMMETRY_FLAG_DIFFERENTIAL`. Runs only against
`perSide:true` + `status:"active"` exercises read live from the versioned Program.

### 3. Escalation compiler — ✅ PASS
Flags aggregate **per exercise + side** (a rough week compresses to one line, not one per instance);
the denominator counts only performed instances (`completed === true`), so a skipped session is
excluded ("3 of your last 4", not "3 of your last 5"). Boundary language is enforced by the templates
themselves — observations are built from structured/enum fields only and never embed the raw
free-text note. The verify harness asserts programmatically (not by eye) that no compiled string
contains any `BANNED_WORDS` (`should`, `try`, `consider doing`, `modify`, `reduce`, `increase`).

**Actual compiled escalation output (boundary language, verbatim from the live run):**
```
[symptom_flag] Right side has been flagged for pain in 3 of your last 4 Single-Leg RDL sessions (most recent 2026-07-18).
               Worth asking your physio whether this needs attention.
[asymmetry]    Right side has shown moderate or higher instability in 3 of your last 3 Single-Leg Squat (Step-Down) sessions.
               Worth asking your physio whether this needs attention.
```
Observation states *that* a pattern exists; the question only points to the physio — no diagnosis, no
cause, no recommendation.

**Keyword-backstop case (case e2):** when `flagForReview` is true via the Phase 2 keyword backstop
(e.g. a note like "gave way") but the model tagged no symptom (`symptomType: "none"`), the observation
falls back to neutral phrasing — *not* the nonsensical "flagged for none":
```
[symptom_flag] Right side Single-Leg RDL has been flagged for review in 2 of your last 2 sessions (most recent 2026-07-17).
               Worth asking your physio whether this needs attention.
```

### 4. Trend — ✅ PASS
`computeTrend` compares the recent `TREND_WINDOW_DAYS` average against the prior window per rating,
with **per-metric polarity** (pain/stiffness down = improving; confidence up = improving). Empty
window → `insufficient_data`. Narration is direction-only (direction label shown in brackets from the
live run):
```
[improving]   painRating trended toward less pain over the last two weeks.
[worsening]   stiffnessRating trended toward more stiffness over the last two weeks.
[plateauing]  confidenceRating held roughly steady over the last two weeks.
```

### Full verify-logic.mjs output
```
✅ PASS — Program items fetched live; per-side list derived: 6 active per-side exercises: ankle_mobility_knee_to_wall, kneeling_hip_flexor_stretch, lateral_band_walks, single_leg_rdl, single_leg_squat_step_down, standing_wall_hip_adduction
✅ PASS — (a) on-target adherence (3 sessions in last 7 days): sessionCount=3, onTarget=true, daysSinceLast=0
✅ PASS — (b) missed session (most recent 3 days ago): daysSinceLast=3, shouldNudge=true, weekCount=2
✅ PASS — (c) asymmetry insufficient_data (2 moderate+ on right): status=insufficient_data, left=0, right=2
✅ PASS — (d) asymmetry flagged (right moderate+ x3, left x0): status=flagged, side=right, left=0, right=3
✅ PASS — (e) escalation compiler (aggregated flags, no banned words): 2 escalations (1 symptom_flag aggregated, 1 asymmetry), 0 banned words
✅ PASS — (e2) escalation keyword-backstop flag (symptomType none): neutral 'flagged for review' phrasing, 0 banned words
✅ PASS — (f) trend improving/worsening/plateauing: pain=improving, stiffness=worsening, confidence=plateauing
✅ PASS — (f) trend insufficient_data (empty prior window): all three metrics insufficient_data
✅ PASS — Sessions pristine after all cases (Count===0): Count=0

RESULT: all cases PASSED
```

### Artifacts added this phase
- `src/logic/thresholds.mjs` — all 7 tunable numbers in one file (see D-13).
- `src/logic/dates.mjs` — pure UTC date helpers (`daysBefore`, `withinTrailingWindow`); no clock.
- `src/logic/sessions.mjs` — shared `isPerformed(sideObj)` predicate: the single "performed
  instance" (completed-flag) rule that is the denominator for BOTH asymmetry and escalation counts,
  so the two paths can't drift (see D-15).
- `src/logic/adherence.mjs` — `checkMissedSession`, `weeklyAdherence`.
- `src/logic/asymmetry.mjs` — `detectAsymmetry`, `activePerSideExercises`, `detectActiveAsymmetries`.
- `src/logic/escalation.mjs` — `compileEscalations`, exported `BANNED_WORDS`.
- `src/logic/trend.mjs` — `computeTrend` (per-metric polarity, direction-only narration).
- `scripts/verify-logic.mjs` — live test harness (all cases above, incl. the keyword-backstop case
  e2); `npm run verify:logic`.
- No infra touched: no new stack, no deploy, nothing under `infra/` or `dist/` changed.

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
- **D-10 (2026-07-20):** Tagging Lambda invokes Nova Lite via the **inference profile**
  `us.amazon.nova-lite-v1:0` (Converse API, forced tool-use), not the direct model id. Rationale:
  the `us.` profile is the documented on-demand path in us-east-1 (proven ACTIVE in Phase 0). Because
  that profile is cross-region, the IAM role grants `bedrock:InvokeModel` on **both** the profile ARN
  and the underlying `foundation-model/amazon.nova-lite-v1:0` ARNs in `us-east-1`/`us-east-2`/`us-west-2`
  — a `us.` profile fans out across all three and invoke is denied without permission on each. Specific
  `toolChoice:{tool:{name}}` was accepted by Nova Lite on the first live call; the planned `{any:{}}`
  fallback was not needed.
- **D-11 (2026-07-20):** Lambda deploy artifact is emitted as `dist/tagging/index.js` (esbuild CJS,
  `--target=node22`, `Handler: index.handler`), **not** a `.cjs` file. Rationale: Lambda's handler
  loader `require()`s the module by its base name, and Node's extensionless require resolves `.js` but
  **not** `.cjs`. Shipping `index.js` in an artifact dir with no `package.json` (so no `"type":"module"`)
  is CJS by default — this is the second option from the Phase 0 §7 note, chosen over the `.cjs` option
  it also listed, because the `.cjs` extension alone would not resolve. `@aws-sdk/*` is marked esbuild
  `--external` (the nodejs22.x runtime provides SDK v3), keeping the bundle at ~7kb. D-7's promise that
  `package` returns in Phase 2 is fulfilled: a real artifact was uploaded to the new
  **`rehab-artifacts-790561527138`** bucket (the `rehab-` naming convention extended to the artifacts
  bucket and the `rehab-tagging` stack/function/role).
- **D-12 (2026-07-21):** `/aws/lambda/rehab-tagging` log-group retention was set to **30 days**
  manually via the console, and is **not yet reflected in `tagging-stack.yaml`**. Recorded as a known
  infra-as-code gap: the template should declare the log group with `RetentionInDays: 30` explicitly
  (and let the function depend on it) rather than rely on a manual console setting that could drift or
  be reset on a redeploy. Not a design change — an IaC gap to close in a later template revision.
- **D-13 (2026-07-20):** All 7 Phase 3 thresholds live in `src/logic/thresholds.mjs` and nowhere
  else, so tuning means editing one file. Values and reasoning: `ADHERENCE_NUDGE_DAYS = 2` (one
  missed day is normal on a 3–4x/week plan; nudging at 2 catches a real gap without nagging).
  `ADHERENCE_WEEKLY_TARGET = 3` (the low end of the prescribed 3–4x/week — the minimum that still
  counts as on-target). `ASYMMETRY_MIN_SAMPLE = 3` (need at least 3 moderate+ instances on a side
  before judging; below this on both sides we report `insufficient_data` rather than guess from
  noise). `ASYMMETRY_FLAG_DIFFERENTIAL = 2` (a 1-instance gap is within normal session-to-session
  variation; a gap of 2+ is a real lean). `ASYMMETRY_WINDOW_DAYS = 30` (long enough to gather 3+
  per-side samples on a 3–4x/week cadence, short enough to reflect the *current* state, not last
  quarter). `TREND_WINDOW_DAYS = 14` (two-week windows give ~6–8 sessions each — enough to average
  out a single bad day while still being recent). `TREND_SIGNIFICANT_SHIFT = 1` (on the small
  integer rating scale, a full 1-point move in the average is a real shift; less reads as
  plateauing). All are starting points, tunable in one place as real data accrues.
- **D-14 (2026-07-20):** Escalation observations are built from **structured/enum fields only**
  (side, symptomType, severity, exerciseName, counts, date) and never embed the raw free-text note.
  Rationale: the no-recommendation boundary must be provable from the templates themselves — a raw
  note like "sharp, should ease off" would leak recommendation language into the compiled output and
  break the guarantee. The raw note stays preserved permanently on the session for the physio; the
  escalation just points to the pattern. `BANNED_WORDS` is exported from `escalation.mjs` so the
  templates and the verify assertion share one source of truth.
- **D-15 (2026-07-20):** Symptom flags aggregate **per exerciseId + side** within the window into one
  observation (count + most-recent date), not one line per occurrence, matching the asymmetry
  aggregation style. Rationale: a rough week should compress into a clear pattern, not flood the
  digest with near-identical lines. The `{total}` denominator counts only performed instances
  (`completed === true`) — a logged-but-skipped session is not a "time performed", so the ratio stays
  honest ("3 of your last 4", never "3 of your last 5" when one was skipped). That denominator rule
  lives in **one** shared predicate, `isPerformed(sideObj)` in `src/logic/sessions.mjs`, used by both
  the asymmetry and escalation counting paths — not duplicated in each — so the completed-flag logic
  can't drift between them if it ever changes. Keyword-backstop flags (`flagForReview` true via a note
  keyword while `symptomType` is `"none"`) fall back to neutral "flagged for review" phrasing, never
  "flagged for none" (proven live by case e2).
- **D-16 (2026-07-20):** Trend direction uses **per-metric polarity**: for `painRating`/
  `stiffnessRating` a downward shift is `improving`; for `confidenceRating` an upward shift is
  `improving`. Narration is direction-only ("trended toward less pain over the last two weeks") and
  never states cause — no "recovering well", no "because". Rationale: trend narration is the point
  where the clinical boundary blurs most easily (per D-6), so the logic reports *that* a rating moved
  and in which direction, never *why*. Tag shape consumed by the logic (`sides.{left,right}.tags[] =
  [{symptomType, severity, flagForReview}]`) is defined here to match Phase 2's exact 3-key tagging
  output landing in the Phase 1 `tags:[]` slot; the session-writer that persists it is Phase 4.

### Teardown note (recorded, not acted on)
`DeletionProtectionEnabled: true` + `DeletionPolicy: Retain` mean deleting `rehab-data` first requires
`aws dynamodb update-table --no-deletion-protection-enabled` on each table, and even then the Retain
policy **orphans** (does not delete) the tables — intentional for the permanent Sessions data.

---

## Next: Phase 4
**Phase 3 fully closed (2026-07-20).** The deterministic logic layer (`src/logic/`) is live and
verified against real tables — adherence, asymmetry, escalation compiler, and trend narration, all
pure functions with no AWS/clock/model, all cases passing via `node scripts/verify-logic.mjs`. The
boundary language is proven clean (no banned recommendation words, structured-fields-only
observations). Ready for Phase 4: the session-writer that persists tagging output into the
`sides.tags[]` slot, and the EventBridge triggers (watcher on session-log for tagging, daily
missed-session check) that feed these pure functions already-fetched data plus an explicit reference
date, then route escalations/summaries to SES and the on-demand frontend.
