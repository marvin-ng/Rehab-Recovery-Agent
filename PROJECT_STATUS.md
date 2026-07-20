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

---

## Next: Phase 1
**Phase 0 fully closed (2026-07-20).** All gates pass, SES identity verified. Cleared to begin Phase 1.
