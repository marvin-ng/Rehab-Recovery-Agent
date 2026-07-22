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

## Phase 4 — Wiring & notify ✅ COMPLETE (2026-07-21)
**Deployed:** two raw-CloudFormation stacks (no SAM). `rehab-log-session` (Function URL + Lambda +
scoped role, stack `rehab-log-session`) and `rehab-notify` (`rehab-nudge` + `rehab-digest` Lambdas,
their roles, a Scheduler execution role, and 3 EventBridge Scheduler rules, stack `rehab-notify`).
Three new bundles built with the same esbuild `--target=node22 --external:@aws-sdk/*` recipe as
Phase 2. Shared modules `src/lib/ddb.mjs` (promoted DocumentClient) and `src/lib/email.mjs` (SESv2
send, imported by both notify Lambdas). The generated Function URL:
`https://6owlutqcgqvjnvbaenmywy2dgi0qvbjr.lambda-url.us-east-1.on.aws/`.

### 0. Pre-flight IAM check — ✅ PASS
`aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::790561527138:user/Marv
--action-names lambda:CreateFunctionUrlConfig lambda:InvokeFunctionUrl` → **both `allowed`** (reported
even though it passed, per prior-phase discipline).

### 1. log-session auth + validation + tagging + persistence — ✅ PASS
Verified over the **real, anonymous HTTPS Function URL** (plain `curl`, no signing — the public path
works after the §5 fix):
- No `x-api-key` → `401 {"error":"unauthorized"}`.
- Wrong `x-api-key` → `401 {"error":"unauthorized"}` (generic; does not reveal missing-vs-wrong).
- Correct `x-api-key` + valid payload with a note (`"felt a sharp catch on the left, almost gave
  way"`) → `200`. The handler invoked `rehab-tagging` Lambda-to-Lambda; the returned tag
  `{symptomType:"pain", severity:"severe", flagForReview:true}` landed on the left side; the
  empty-note right side got `tags:[]`. Item asserted present in `rehab-sessions`, then **deleted in
  cleanup** (Count → 0). Insert/assert/delete discipline held; table left pristine.

### 2. nudge — ✅ PASS (first real email send of the project)
- **Should-nudge** (empty table): `{"nudged":true,"daysSinceLastSession":null}` — email **confirmed
  delivered** to the account (located in Gmail's Spam folder, reclassified as not-spam; see D-24). Uses
  the proven Phase 1 most-recent-session query (`ScanIndexForward:false, Limit:1`), not a trailing
  window, so a gap of any length reports correctly.
- **Should-not-nudge** (a session dated today): `{"nudged":false,"daysSinceLastSession":0}` — no email,
  clean exit. Test session cleaned up (Count → 0).
- **Actual nudge email content** (subject / body):
  ```
  Subject: Rehab check-in
  No logged sessions yet. Your program calls for 3-4x/week.
  ```
  (When at least one session exists, the body is the numeric form:
  `It's been {N} days since your last logged session. Your program calls for 3-4x/week.`)

### 3. digest weekly + monthly — ✅ PASS
Ran against 7 seeded sessions over 28 days (left-side moderate pain flags + improving ratings), then
deleted all 7 (Count → 0). Lambda returns: weekly `{escalationCount:2, includedTrend:false}`, monthly
`{escalationCount:2, includedTrend:true}`; bad `digestType` fails loud
(`Error: invalid digestType: "quarterly"`). Both digest emails were **confirmed delivered** to the
account (Gmail Spam, reclassified not-spam; see D-24). The **actual composed email bodies** (reproduced
by running the deployed `composeBody` + the real Phase 3 logic modules against the identical seed and
`asOfDate` 2026-07-21 — byte-for-byte what SES sent):

```
Subject: Weekly rehab summary
Weekly rehab summary — as of 2026-07-21

ADHERENCE
Sessions logged in the last 7 days: 3 (target: 3-4/week).
On target.

FLAGS TO BRING UP WITH YOUR PHYSIO
- Left side has been flagged for pain in 3 of your last 3 Single-Leg RDL sessions (most recent 2026-07-20). Worth asking your physio whether this needs attention.
- Left side has shown moderate or higher pain in 4 of your last 7 Single-Leg RDL sessions. Worth asking your physio whether this needs attention.
```

```
Subject: Monthly rehab summary
Monthly rehab summary — as of 2026-07-21

ADHERENCE
Sessions logged in the last 7 days: 3 (target: 3-4/week).
On target.

FLAGS TO BRING UP WITH YOUR PHYSIO
- Left side has been flagged for pain in 4 of your last 7 Single-Leg RDL sessions (most recent 2026-07-20). Worth asking your physio whether this needs attention.
- Left side has shown moderate or higher pain in 4 of your last 7 Single-Leg RDL sessions. Worth asking your physio whether this needs attention.

TREND (last two weeks vs the prior two)
- painRating trended toward less pain over the last two weeks.
- stiffnessRating trended toward less stiffness over the last two weeks.
- confidenceRating trended toward higher confidence over the last two weeks.
```
Note the **weekly** symptom flag reads "3 of your last **3**" (7-day escalation scope) while
**monthly** reads "4 of your last **7**" (30-day scope), and only monthly carries the TREND section —
proving the dual-cadence escalation scoping (D-22) works. Boundary held: every line reports a pattern
and hands a question to the physio; nothing diagnoses or explains *why*.

### 4. EventBridge Scheduler rules — ✅ PASS (verified via `scheduler get-schedule`, not template trust)
All three **ENABLED**, `FlexibleTimeWindow: OFF`, timezone `America/New_York`:
| Name | Cron | Target | Input |
|---|---|---|---|
| `rehab-nudge-daily` | `cron(0 7 * * ? *)` | `rehab-nudge` | (none) |
| `rehab-digest-weekly` | `cron(0 7 ? * FRI *)` | `rehab-digest` | `{"digestType":"weekly"}` |
| `rehab-digest-monthly` | `cron(0 7 28 * ? *)` | `rehab-digest` | `{"digestType":"monthly"}` |

### 5. Function URL public reachability — ✅ PASS (fixed in template; corrected diagnosis)
Anonymous calls to the `AuthType: NONE` URL initially returned `403` before reaching the handler. The
**real cause was an incomplete resource-based policy, not an account-level public-access block.** An
`AuthType: NONE` Function URL needs **two** resource-policy grants, and the template only had the
first:
1. `lambda:InvokeFunctionUrl` (Principal `*`, condition `FunctionUrlAuthType=NONE`) — call the URL.
2. `lambda:InvokeFunction` (Principal `*`, condition `Bool lambda:InvokedViaFunctionUrl=true`) —
   actually invoke the function behind the URL.

With only (1), anonymous requests 403 at the edge. Adding (2) — expressed natively in CloudFormation
via `AWS::Lambda::Permission` with `Action: lambda:InvokeFunction` + `InvokedViaFunctionUrl: true` —
fixes it. Both grants now live in `infra/log-session-stack.yaml`, so the fix survives a stack
delete/redeploy (no manual patch). The earlier "account-level public-access block" theory was **wrong**
and is retracted; the `put-public-access-block-config` remediation is **not** needed.

Verified after redeploy (stack → `UPDATE_COMPLETE`) with the CFN-managed grants as the **sole** policy
statements (the temporary manual `AllowPublicInvokeFunction` patch was removed first, proving the
template alone suffices): plain anonymous `curl` → no key `401`, wrong key `401`, correct key + note
`200` (item persisted with tags, then deleted, Count → 0). See §1.

### 6. Secret hygiene — ✅ PASS
32-byte secret (`openssl rand -hex 32`) written to gitignored `.secrets/session-log-secret`, supplied
to CloudFormation via a `NoEcho` parameter sourced by command substitution
(`SessionLogSecret="$(cat .secrets/session-log-secret)"`) — never typed inline. Proof it is not
committed: `git status` shows `.secrets/` only under `--ignored` (`!!`), `git grep` for the secret
value across tracked files returns nothing, and `.gitignore` carries `.secrets/`.

### Artifacts added this phase
- `src/lib/ddb.mjs`, `src/lib/email.mjs` (shared DocumentClient + SESv2 send).
- `src/log-session/handler.mjs`, `src/nudge/handler.mjs`, `src/digest/handler.mjs` (+ exported
  `composeBody` for deterministic reproduction).
- `infra/log-session-stack.yaml`, `infra/notify-stack.yaml`.
- `package.json`: `build:log-session` / `build:nudge` / `build:digest` scripts; `@aws-sdk/client-sesv2`
  dev dep. `.gitignore`: `.secrets/`.

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
- **D-12 (2026-07-21) — CLOSED (2026-07-22, Phase 6 Part A):** `/aws/lambda/rehab-tagging` log-group
  retention was originally set to **30 days** manually via the console and **not reflected in
  `tagging-stack.yaml`** — a known infra-as-code gap. **Now closed:** `tagging-stack.yaml` declares a
  `TaggingLogGroup` (`AWS::Logs::LogGroup`, `RetentionInDays: 30`), `TaggingFunction` gains
  `DependsOn: TaggingLogGroup`, and the role's `WriteLogs` statement was tightened to match the other
  two stacks (dropped `logs:CreateLogGroup`, now only `CreateLogStream` + `PutLogEvents`, resource
  suffix `:*`). Because the group already existed, it was deleted first (30-day ephemeral logs only),
  race-guarded to empty, then recreated stack-managed via the proven `package`→`deploy` path. Verified
  live — see the Phase 6 Part A section below.
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
- **D-17 (2026-07-21):** The log-session endpoint is a **Lambda Function URL with `AuthType: NONE` at
  the edge, gated by a shared-secret `x-api-key` header checked in-handler** before any parsing or
  validation, against a `NoEcho` env var. Rationale: the locked spec wants a public, login-free write
  endpoint; a shared secret keeps it usable from a simple frontend without an auth stack, and the
  handler returns a **generic 401** for missing-or-wrong (never revealing which) using a constant-time
  hash compare. Tradeoff: a shared secret is weaker than signed IAM auth and must be rotated if leaked,
  but it matches the single-user, no-login design and keeps the door-check logic auditable in one place.
  The secret is generated locally, stored gitignored, and passed via CloudFormation `NoEcho` — never
  committed, never logged.
- **D-18 (2026-07-21):** **One `rehab-digest` Lambda serves both cadences**, branching on an
  EventBridge Scheduler input payload (`{"digestType":"weekly"}` vs `"monthly"`) from two separate
  rules. Rationale: weekly and monthly share ~90% of the composition (adherence + asymmetry +
  escalations); a single handler keeps that logic in one place and lets the cadence differences
  (monthly-only trend section, weekly-only 7-day escalation scope) live as small branches rather than a
  duplicated Lambda. The trigger, not the code, decides which cadence runs.
- **D-19 (2026-07-21):** **Permissive CORS (`AllowOrigins: ["*"]`) on the Function URL is a temporary
  Phase-4 decision, to be tightened in Phase 5.** Rationale: there is no known frontend origin yet, so
  locking CORS now would be guessing. Once Phase 5 has a real deployed origin, restrict `AllowOrigins`
  to it. Recorded explicitly so it is not forgotten. (Note: CORS is a browser convenience, not the
  security control — the `x-api-key` check is; per D-17.)
- **D-20 (2026-07-21):** **One shared `src/lib/email.mjs` (`sendRehabEmail`)** wraps the single SESv2
  `SendEmailCommand`; both `rehab-nudge` and `rehab-digest` import it. Rationale: same lesson as Phase
  3's shared `isPerformed()` — no duplicated SES setup/send between the two Lambdas, so sender/recipient
  and error handling can't drift. Sends from/to the one verified sandbox identity
  `marvin.ngonadi@gmail.com` (D-4).
- **D-21 (2026-07-21):** **`ddb.mjs` was promoted into `src/lib/`** (mirroring the dev-side
  `scripts/lib/ddb.mjs`) so bundled Lambda code imports a DocumentClient from `src/` without reaching
  across the `src/`↔`scripts/` boundary. Rationale: the logic modules already live under `src/`; a
  `src/lib/` peer keeps Lambda imports clean and esbuild-bundleable. The two copies are intentionally
  parallel (dev tooling vs deployed code), not shared, to avoid coupling the deploy bundle to the
  scripts tree.
- **D-22 (2026-07-21):** **Weekly and monthly digests scope escalations differently.**
  `detectActiveAsymmetries` keeps its full ~30-day window in both (it genuinely needs the history to
  reach its minimum sample), but the **weekly** digest passes `compileEscalations` a session set
  filtered to the **last 7 days**, while **monthly** passes the full window. Rationale: a flag must not
  re-surface in four consecutive weekly emails (that would train the reader to ignore it); a monthly
  roundup restating a flag once already mentioned is acceptable. So weekly reports "new this week",
  monthly reports "the month".
- **D-23 (2026-07-21):** **An anonymous `AuthType: NONE` Function URL requires TWO resource-policy
  grants, and both are now codified in the template.** The `403` on anonymous calls was an **incomplete
  resource-based policy**, not an account-level public-access block (that earlier theory is retracted —
  the `put-public-access-block-config` route was a dead end and the operation isn't even in the current
  SDK/CLI). AWS needs `lambda:InvokeFunctionUrl` (call the URL) **and** a separate `lambda:InvokeFunction`
  grant conditioned on `Bool lambda:InvokedViaFunctionUrl=true` (invoke the function behind it); with
  only the first, requests 403 at the edge before the handler runs. Rationale for codifying: the second
  grant is expressible natively in CloudFormation (`AWS::Lambda::Permission` with `Action:
  lambda:InvokeFunction` + `InvokedViaFunctionUrl: true`), so it belongs in
  `infra/log-session-stack.yaml` alongside the first — a manual `add-permission` patch would silently
  reappear as a gap on any stack delete/redeploy. The in-handler shared-secret check (D-17) remains the
  actual access control; these two grants only govern whether a request reaches that check at all.
  Verified live after redeploy with the CFN-managed grants as the sole policy statements (manual patch
  removed first): anonymous curl → `401` without key, `200` with the correct key.
- **D-24 (2026-07-21):** **All three email types (nudge, weekly digest, monthly digest) are confirmed
  delivered end-to-end — they were landing in Gmail's Spam folder, not failing to send.** This is a
  **known limitation, not fixed this phase.** What was checked: the raw SES send responses all carried
  a `MessageId` (SES accepted every send); the SES **suppression list** was confirmed to not contain
  the recipient (not suppressed); the account **sending status** was healthy/enabled. The messages were
  then found in the Gmail **Spam** folder — a delivery/placement outcome, not a send failure — and
  marked **"Not spam"** to begin retraining the filter. Why it happens: the SES sandbox identity is a
  **bare verified email address**, not a domain identity, so outbound mail has **no SPF/DKIM
  authentication signal**; combined with a **brand-new sending identity** (no prior reputation) and
  **no recipient engagement history**, Gmail defaults to skepticism for exactly this pattern and files
  it as spam. **Not fixed now** because the real fix — verifying a **domain identity with DKIM** (and
  ideally SPF/DMARC) instead of a bare address — is out of scope for this single-user portfolio build;
  noted as a future improvement. For this build, delivery-to-account is proven; inbox placement is best
  handled by the recipient marking not-spam.
- **D-25 (2026-07-22, Phase 6 Part A):** **Bedrock model invocation logging is intentionally a
  documented CLI runbook, not IaC.** CloudFormation has **no resource type** for it — verified against
  the live registry: `AWS::Bedrock::Guardrail` and `AWS::Bedrock::KnowledgeBase` resolve via
  `describe-type`, but `AWS::Bedrock::ModelInvocationLoggingConfiguration` (and the shorter
  `AWS::Bedrock::LoggingConfiguration`) return `TypeNotFoundException`. The setting is also
  **account+region-level** (one config per region via `PutModelInvocationLoggingConfiguration`), not a
  per-stack resource, so no stack could own it even if a type existed. Rather than leave it as a silent
  manual step, the exact recreation steps (log group, delivery IAM role with its precise trust +
  permissions policies, the enable call, and a verify) are captured as a **runbook** in the Phase 6
  Part A section below, keyed to the live config. The AWS **CLI** does support it, so the runbook is CLI
  commands, not console click-through. If AWS later ships a CloudFormation resource type, migrate it
  into a stack and retire the runbook.

### Teardown note (recorded, not acted on)
`DeletionProtectionEnabled: true` + `DeletionPolicy: Retain` mean deleting `rehab-data` first requires
`aws dynamodb update-table --no-deletion-protection-enabled` on each table, and even then the Retain
policy **orphans** (does not delete) the tables — intentional for the permanent Sessions data.

---

## Next: Phase 5
**Phase 4 fully closed (2026-07-21).** The wiring is live: the `rehab-log-session` Function URL
persists real sessions and tags each note via the `rehab-tagging` Lambda; `rehab-nudge` and
`rehab-digest` run on three EventBridge Scheduler rules and send real SES email (first real sends of
the project). All paths verified live — anonymous-HTTPS handler auth (401s), full write+tag+persist
(200), both nudge branches, both digest cadences with correct escalation scoping and monthly-only
trend, and all three schedules ENABLED with correct cron/timezone/input. The Function URL public-access
`403` was root-caused to an incomplete resource-based policy (missing the second `InvokeFunction`
grant) and **fixed in the template** (D-23), verified with the CFN-managed grants as the sole policy.
The clinical boundary held throughout: digests report patterns and hand questions to the physio, never
diagnose or explain *why*.

**Ready for Phase 5:** the on-demand frontend deep view (logging form, weekly visual trend, session
comparison, full detail behind the summary email). Phase 5 will also give the Function URL a real
origin to replace the temporary permissive CORS (D-19).

---

## Phase 5 (Part A) — Frontend + read endpoint — ✅ COMPLETE (2026-07-21)
Local-only milestone: the on-demand frontend (Vite + React + TS + shadcn/ui) plus the one read-only
backend endpoint it needs. **No Vercel deploy** — that is Part B. Verified end-to-end against the live
AWS backend.

**Deployed (backend):** the existing `rehab-log-session` stack was extended in place (not a new stack)
with a second Lambda + Function URL, `rehab-dashboard-data` (read-only GET). Redeployed via the proven
`aws cloudformation package` → `deploy` path (artifacts bucket `rehab-artifacts-790561527138`,
`--capabilities CAPABILITY_NAMED_IAM`, secret via the `ApiSecret` NoEcho param). Stack →
`UPDATE_COMPLETE`.

Function URLs (both AuthType NONE at the edge, shared secret in-handler):
- log-session (POST): `https://6owlutqcgqvjnvbaenmywy2dgi0qvbjr.lambda-url.us-east-1.on.aws/`
- dashboard-data (GET): `https://bsve7qr3msascmtlcmfng5rbsy0uoudi.lambda-url.us-east-1.on.aws/`

### 1. `rehab-dashboard-data` (read-only) — ✅
`src/dashboard-data/handler.mjs` queries active Program items + a ~60-day Sessions window, then calls
the EXISTING Phase 3 pure logic directly (`weeklyAdherence`, `detectActiveAsymmetries`,
`compileEscalations`, `computeTrend`) — no math re-implemented. Returns one payload:
`{ asOfDate, adherence, asymmetryResults, escalations, trend, recentSessions, programItems }`.
`programItems` is included so the logging form renders without a second endpoint. `recentSessions` is a
display-only history list carrying, per side, `completed` + `rawNote` + `tags` (raw notes were kept
permanently in Phase 1 precisely to be read back here). The clinical boundary is untouched:
`compileEscalations` still builds observation/question text from structured fields only; the frontend
renders that text **verbatim**.
**IAM (least privilege):** inline policy grants `dynamodb:Query` on **both** table ARNs and CloudWatch
Logs — nothing else. No `PutItem`, no `InvokeFunction` (contrast log-session, which needs both).

### 2. Secret check consolidated — ✅
The constant-time, length-tolerant sha256 compare was extracted from `rehab-log-session`'s handler into
`src/lib/auth.mjs` as a single `verifyApiSecret(event)`. Both handlers import it and call it first,
before any other processing. The env var `SESSION_LOG_SECRET` was renamed **`API_SECRET`** (and the
NoEcho parameter `SessionLogSecret` → `ApiSecret`) since it now gates two endpoints. Secret value
unchanged (still sourced from gitignored `.secrets/session-log-secret`).

### 3. curl smoke test (both endpoints, before frontend) — ✅
Re-verified the refactor didn't break either path — including the **wrong-key** case specifically, not
just missing-key, since the compare now lives in a shared module consumed by a second handler:

| | no key | wrong key | correct key |
|---|---|---|---|
| dashboard-data (GET) | 401 | 401 | 200 (payload) |
| log-session (POST) | 401 | 401 | 400 validation (auth passed) |

### 4. Frontend — ✅
`web/` scaffolded with `npm create vite` (react-ts). shadcn set up with the specified preset: `init`
told us `apply` needs `components.json` first, so `npx shadcn@latest init --preset b7CSh7vqC` ran
first (Tailwind v4 + a monochrome theme, Inter Variable font, `tw-animate-css` + `shadcn/tailwind.css`,
`src/lib/utils.ts`, `components.json`), then `npx shadcn@latest apply --preset b7CSh7vqC` → **"Preset
applied successfully."** Components added: button, card, checkbox, textarea, slider, chart (Recharts),
table, input, label, badge, tabs, sonner.
- **Auth gate** (`src/components/AuthGate.tsx` + `src/lib/api.ts`): on load, checks `localStorage` for
  the key; if absent, only the "Enter access key" screen renders. Stored on submit; sent as `x-api-key`
  on every call. Any `401` clears the key and re-shows the gate with an error — no silent retry.
- **Log Session** (`src/views/LogSession.tsx`): active exercises grouped by section; per-side checkbox
  + note textarea where `perSide`, single checkbox otherwise; three shadcn Sliders (0–10); POSTs to the
  log-session Function URL.
- **Dashboard** (`src/views/Dashboard.tsx`): adherence, asymmetry flags, escalations (verbatim), a
  trend line chart (shadcn Chart / Recharts) of the three ratings over session dates, and a session
  history table with per-side notes. **Honest empty states**: `insufficient_data` (asymmetry, trend)
  and empty `escalations` render explicit "not enough data yet" / "No flagged concerns" copy — this is
  what first real use shows, not an edge case.
- **Chart color:** the preset's `--chart-1..5` are near-monochrome (three lines would be
  indistinguishable), so the trend series use a validated CVD-safe categorical trio from the dataviz
  default palette (pain=blue, stiffness=orange, confidence=aqua), stepped per light/dark mode, carried
  as `--series-*` CSS vars. Validated with the dataviz validator (`--pairs all`, light + dark: all CVD
  and normal-vision checks PASS; light-mode aqua's sub-3:1 contrast WARN is relieved by the always-on
  legend + the raw-value history table).

### 5. Local verification (against live AWS) — ✅
- **End-to-end write:** replicated the frontend's exact `submitSession` request (Function URL from
  `web/.env.local`, `x-api-key` header, real payload shape) with a throwaway date `2020-01-15` (Sessions
  SK is the date, so a same-date log overwrites — avoided clobbering real data). → `200 {ok:true}`, item
  landed in `rehab-sessions` with the note AI-tagged (`symptomType:pain, severity:severe,
  flagForReview:true`), then deleted; table Count back to `0`.
- **Browser (headless Chrome via CDP):** auth gate renders and is the *only* thing shown with no key;
  with the real key injected into `localStorage`, the Dashboard renders real data (adherence 0 / below
  target, "No flagged concerns", asymmetry + trend "not enough data yet", empty history — the true
  first-use state); the Log Session view renders all 9 active exercises grouped by section with correct
  per-side vs single controls and the three sliders.
- **Invalid key → re-prompt:** with a wrong key in `localStorage`, the 401 cleared the stored key
  (`localStorage` back to `null`) and re-showed the gate with "That access key was rejected. Please try
  again." — no silent retry.
- **dist/ secret grep (the actual proof):** `npm run build`, then
  `grep -rF "$(cat ../.secrets/session-log-secret)" dist/` → **zero matches**. The 64-char secret is
  never bundled; the key only ever comes from user input into `localStorage`. (The `rehab.apiKey`
  *storage-key name* does appear in the bundle — that is app code, not the secret.)

### CORS — intentionally deferred (not forgotten)
Both Function URLs keep `AllowOrigins: ["*"]` for now (D-19). Locking this to the real Vercel origin is
explicitly **Part B**, once a deployed domain exists — deferred deliberately, tracked here.

### Artifacts added this phase
- `src/lib/auth.mjs` (shared `verifyApiSecret`), `src/dashboard-data/handler.mjs`.
- `infra/log-session-stack.yaml`: `ApiSecret` param + the `rehab-dashboard-data` role/loggroup/function/
  URL/permissions/output.
- `package.json`: `build:dashboard-data` script.
- `web/` — the full Vite + React + TS + shadcn app (gitignored `dist/` and `.env.local`; committed
  `.env.example` with the non-secret Function URLs).

---

## Phase 5 (Part B) — CORS locked to production origin — ✅ COMPLETE (2026-07-21)
Closes **D-19 for real** (it had been "deferred" through Phase 4 and Phase 5 Part A). The frontend is
deployed at `https://rehab-recovery-agent.vercel.app`; both Function URLs now allow that origin only.

### 1. Template change — ✅
`infra/log-session-stack.yaml`: `AllowOrigins` on **both** Function URL resources changed from `["*"]`
to `["https://rehab-recovery-agent.vercel.app"]` (exact match, https explicit, no trailing slash).
Redeployed via the standard `aws cloudformation package` → `deploy` (stack → `UPDATE_COMPLETE`). Live
config confirmed via `aws lambda get-function-url-config` — both show the single production origin
(log-session: POST; dashboard-data: GET).

### 2. CORS proof, both directions (the real evidence, not a claim) — ✅
Preflight (`OPTIONS`) with `Access-Control-Request-Method`, comparing the real origin against a fake one:

```
###### DASHBOARD-DATA (GET) ######
--- Origin: https://rehab-recovery-agent.vercel.app ---
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://rehab-recovery-agent.vercel.app
Access-Control-Allow-Methods: GET
--- Origin: https://evil.example.com ---
HTTP/1.1 200 OK
(no Access-Control-Allow-Origin header)

###### LOG-SESSION (POST) ######
--- Origin: https://rehab-recovery-agent.vercel.app ---
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://rehab-recovery-agent.vercel.app
Access-Control-Allow-Methods: POST
--- Origin: https://evil.example.com ---
HTTP/1.1 200 OK
(no Access-Control-Allow-Origin header)
```

The real origin is echoed back in `Access-Control-Allow-Origin`; the fake origin gets **no such header
at all**. The request still returns HTTP 200 (Function URL CORS is advisory headers — enforcement is in
the browser, not the server), but a browser will block `evil.example.com` because it is never granted.

### 3. End-to-end from the DEPLOYED frontend (headless Chrome at the vercel.app origin) — ✅
Driven in a real browser so the `Origin: https://rehab-recovery-agent.vercel.app` header is genuine and
the browser actually enforces CORS. **Zero `Network.loadingFailed`/CORS-block events** in either flow:
- **Dashboard (GET):** real data rendered, no auth gate — the allowed origin passes for the read path.
- **Log Session (POST):** submitted through the deployed form → "Session logged." toast, item confirmed
  in `rehab-sessions`, then deleted — the allowed origin passes for the write path.

### 4. ⚠️ Incident + full recovery (recorded honestly) — RESOLVED
During step 3 the write test was first run against **today's date (2026-07-21)**, which already held a
**real logged session**. Because the Sessions sort key *is* the date, the handler's `PutItem`
**overwrote** the real session with the minimal test log. Root cause: the test used the live "today"
default instead of a throwaway date (the exact same-date-overwrite hazard the Part A plan had already
flagged for its own write test).
- **Recovery:** PITR was enabled on `rehab-sessions` (D-8). `LatestRestorableDateTime` (22:31:00Z)
  predated the overwrite (`loggedAt` 22:34:19Z), so `restore-table-to-point-in-time
  --use-latest-restorable-time` into a temp table `rehab-sessions-recovery` captured the intact
  original. The `2026-07-21` item (same `sessionId` `f538f9d0…`, `loggedAt` `21:29:11Z`, all 9
  exercises / 15 sides, notes, and AI tags `instability`/`fatigue`) was `PutItem`-copied back into
  `rehab-sessions`; the temp table was deleted. Final live state verified: **Count 1**, the single
  `2026-07-21` session restored byte-for-byte (`sessionId` matches).
- **Re-test done safely:** step 3's write was re-run with a **throwaway empty date `2026-07-15`**
  (verified empty first, deleted after), so the proof was obtained without risking real data.
- **Lesson (carry forward):** any live write test against `rehab-sessions` MUST use a throwaway date —
  a same-date log is a silent full-item overwrite, not a merge. PITR is the safety net and it worked,
  but the primary guard is never writing a test payload to a date that may hold real data.
- **Structural fix (not just documented):** the two verify harnesses that seed+delete synthetic
  sessions (`scripts/verify-data.mjs`, `scripts/verify-logic.mjs`) previously anchored their dates to
  **today / a real recent date** — running `npm run verify` today would have overwritten *and then
  deleted-in-`finally`* the real 2026-07-21 session (with no PITR restore in the loop). Both now import a
  shared **`TEST_ONLY_DATE` (`2000-06-15`)** + `TEST_ONLY_RANGE` (year-2000) from `scripts/lib/ddb.mjs`
  and anchor every seeded date there, so test writes/deletes live in a namespace no real session can
  ever occupy. Cleanup, the "most recent", "pristine", and logic read-back queries are all scoped to
  `TEST_ONLY_RANGE` (`SK BETWEEN 2000-01-01 AND 2000-12-31`) instead of the whole partition — the
  harnesses are now hermetic against real data. **Verified live:** both scripts pass with a real
  session present, and that session (`sessionId f538f9d0…`, 9 exercises) is byte-for-byte unchanged
  afterward. This closes the mistake class structurally, not just in prose.

### 5. Known limitation — Vercel preview deployments (intentional scope, not an oversight)
CORS now allows **only** the production domain `https://rehab-recovery-agent.vercel.app`. Vercel gives
every non-`main` branch/preview build its **own random domain** (e.g.
`rehab-recovery-agent-git-<branch>-<scope>.vercel.app`), which is **not** in the allowlist and will be
blocked by CORS in the browser. This is **deliberate** for a single-developer project: a wildcard or a
`*.vercel.app` suffix match would re-open the origin to any Vercel-hosted site, defeating the lock. If a
preview URL ever needs to reach the live backend, add that exact origin to `AllowOrigins` for the
duration — don't broaden the pattern. Not needed for this build.

### D-19 — CLOSED (2026-07-21)
Wildcard CORS existed as a deliberate placeholder from Phase 4 (no known frontend origin) through
Phase 5 Part A (no deployed domain yet). With the production Vercel domain live, both Function URLs are
locked to it exactly. No longer deferred.

---

## Phase 6 (Part A) — IaC hardening: close two long-standing gaps ✅ COMPLETE (2026-07-22)
No new features, no new Lambdas. Two settings that lived only in the AWS Console — and would silently
vanish on a clean redeploy from an empty account — are now either codified (D-12) or captured as an
exact runbook (Bedrock logging, D-25). Then the whole deploy was re-proven healthy and least-privilege.

### 1. D-12 closed — tagging log group is now IaC — ✅
`infra/tagging-stack.yaml` now declares `TaggingLogGroup` (`AWS::Logs::LogGroup`, `RetentionInDays:
30`), adds `DependsOn: TaggingLogGroup` to `TaggingFunction`, and tightens the role's `WriteLogs`
statement (dropped `logs:CreateLogGroup` — CFN owns the group now — keeping `CreateLogStream` +
`PutLogEvents`, resource suffix `:*`), matching `log-session-stack.yaml` / `notify-stack.yaml`.

**Deploy sequence (the group already existed, so a plain add would 409 "already exists"):**
1. `aws logs delete-log-group --log-group-name /aws/lambda/rehab-tagging --region us-east-1` — removed
   the orphaned manual group (30-day ephemeral operational logs only; no persisted data there).
2. **Race guard:** `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/rehab-tagging`
   returned `[]` (empty) — confirmed nothing re-invoked the Lambda and recreated the group in the
   window before deploying. (If it had been non-empty, the rule was: stop, re-delete, re-check — never
   deploy on top of a recreated group.)
3. `npm run build:tagging` → `aws cloudformation package` (bucket `rehab-artifacts-790561527138`) →
   `aws cloudformation deploy --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset`.

**Verified live — immediately post-deploy:**
- Stack `rehab-tagging` → **UPDATE_COMPLETE**.
- `describe-log-groups` → retention **30**.
- `describe-stack-resources` → the group is now a stack resource: `TaggingLogGroup` /
  `/aws/lambda/rehab-tagging` / **CREATE_COMPLETE** (i.e. stack-managed, not console drift).

**Verified live — durability after REAL traffic (a stronger claim than post-create):** ran
`npm run verify:tagging` (5 live invocations of the deployed Lambda, all PASS incl. the case-e
adversarial boundary proof). Re-checked afterward: retention still **30**, still the **same**
stack-managed `TaggingLogGroup`, and a real log stream (`2026/07/22/[$LATEST]…`) was written into it.
Real Lambda traffic logs into the CFN-managed group without detaching it or resetting retention —
proving the group *stays* stack-managed after use, not just at creation. (The tagging Lambda writes no
DynamoDB items, so the test invokes left nothing to clean up.)

### 2. Bedrock model invocation logging — runbook (D-25), because CloudFormation can't own it — ✅
**First checked:** does CloudFormation support a resource type for this? **No** — verified against the
live registry with `describe-type`: `AWS::Bedrock::Guardrail` and `AWS::Bedrock::KnowledgeBase` resolve,
but `AWS::Bedrock::ModelInvocationLoggingConfiguration` and `AWS::Bedrock::LoggingConfiguration` both
return `TypeNotFoundException`. It is also an **account+region-level** setting (one per region), not a
per-stack resource. So it cannot be codified; instead here is the exact runbook to recreate the live
setup (`/aws/bedrock/recovery-watcher` + `BedrockLoggingRole-RecoveryWatcher`) from an empty account.
The AWS **CLI** supports every step, so this is CLI, not console click-through. Region `us-east-1`,
account `790561527138` throughout.

**Runbook — recreate Bedrock model invocation logging from scratch:**

Step 1 — create the destination log group (retention 30, matching everything else):
```
aws logs create-log-group --log-group-name /aws/bedrock/recovery-watcher --region us-east-1
aws logs put-retention-policy --log-group-name /aws/bedrock/recovery-watcher \
  --retention-in-days 30 --region us-east-1
```

Step 2 — create the delivery IAM role Bedrock assumes to write those logs. Trust policy
(`bedrock-logging-trust.json`) — scoped with the SourceAccount/SourceArn confused-deputy guards:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AmazonBedrockModelInvocationCWDeliveryRole",
    "Effect": "Allow",
    "Principal": { "Service": "bedrock.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "790561527138" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock:us-east-1:790561527138:*" }
    }
  }]
}
```
Permissions policy (`bedrock-logging-perms.json`) — write only to that one log group's
model-invocations stream:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AmazonBedrockModelInvocationCWDeliveryRole",
    "Effect": "Allow",
    "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": "arn:aws:logs:us-east-1:790561527138:log-group:/aws/bedrock/recovery-watcher:log-stream:aws/bedrock/modelinvocations"
  }]
}
```
Create + attach:
```
aws iam create-role --role-name BedrockLoggingRole-RecoveryWatcher \
  --assume-role-policy-document file://bedrock-logging-trust.json
aws iam put-role-policy --role-name BedrockLoggingRole-RecoveryWatcher \
  --policy-name BedrockLoggingRole-RecoveryWatcher-policy \
  --policy-document file://bedrock-logging-perms.json
```
(The live role attaches this as a managed `service-role/…` policy created by the console; a plain inline
`put-role-policy` is functionally identical and simpler to script from scratch.)

Step 3 — enable model invocation logging pointing at that group + role:
```
aws bedrock put-model-invocation-logging-configuration --region us-east-1 \
  --logging-config '{
    "cloudWatchConfig": {
      "logGroupName": "/aws/bedrock/recovery-watcher",
      "roleArn": "arn:aws:iam::790561527138:role/BedrockLoggingRole-RecoveryWatcher"
    },
    "textDataDeliveryEnabled": true,
    "imageDataDeliveryEnabled": true,
    "embeddingDataDeliveryEnabled": true,
    "videoDataDeliveryEnabled": true,
    "audioDataDeliveryEnabled": false
  }'
```

Step 4 — verify it took:
```
aws bedrock get-model-invocation-logging-configuration --region us-east-1
```
Expect the config above echoed back. **Confirmed live this phase** — the current account already
returns exactly this (log group `/aws/bedrock/recovery-watcher`, role
`BedrockLoggingRole-RecoveryWatcher`, text/image/embedding/video on, audio off). This runbook was
**not re-run against the live account** (that would be a no-op); it was authored by reading the live
config back and is the source of truth for a from-scratch rebuild.

### 3. Full-stack re-verify — ✅
**Stack health** (`describe-stacks`, all `rehab*`): `rehab-data` CREATE_COMPLETE, `rehab-tagging`
UPDATE_COMPLETE (this phase), `rehab-log-session` UPDATE_COMPLETE, `rehab-notify` CREATE_COMPLETE.
Nothing drifted.

**Least-privilege spot-check** via `iam simulate-principal-policy` (same method as Phase 0/4 — evaluates
the real attached policy, not the template). For each role: intended actions **allowed**, a
representative out-of-scope action **implicitDeny**. All 18 as expected:

| Role | allowed | implicitDeny (out of scope) |
|------|---------|------------------------------|
| `rehab-tagging-role` | `dynamodb:GetItem` (program), `bedrock:InvokeModel` (nova-lite profile) | `dynamodb:PutItem` (program) |
| `rehab-log-session-role` | `dynamodb:PutItem` (sessions), `lambda:InvokeFunction` (tagging) | `dynamodb:Query` (sessions) |
| `rehab-dashboard-data-role` | `dynamodb:Query` (program + sessions) | `dynamodb:PutItem` (sessions) |
| `rehab-nudge-role` | `dynamodb:Query` (sessions), `ses:SendEmail` | `dynamodb:PutItem` (sessions) |
| `rehab-digest-role` | `dynamodb:Query` (program + sessions), `ses:SendEmail` | `dynamodb:PutItem` (sessions) |
| `rehab-scheduler-role` | `lambda:InvokeFunction` (nudge + digest) | — |

Plus a targeted check that the D-12 IAM tightening took effect on `rehab-tagging-role`:
`logs:CreateLogGroup` → **implicitDeny** (correctly removed), while `logs:CreateLogStream` /
`logs:PutLogEvents` → **allowed**. The durability test above already proved the Lambda still logs fine
without `CreateLogGroup`, since CloudFormation now owns the group.

### Artifacts changed this phase
- `infra/tagging-stack.yaml` — `TaggingLogGroup` resource, `DependsOn`, tightened `WriteLogs`.
- `PROJECT_STATUS.md` — this section; D-12 marked CLOSED; new **D-25** (Bedrock logging runbook).
- No new Lambdas, no code changes, no CLAUDE.md change (nothing here contradicts a locked decision).
