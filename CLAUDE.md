# CLAUDE.md — Recovery Adherence & Asymmetry Watcher

## What this is
An always-on AWS agent that organizes, reminds, tracks, and summarizes Marvin's prescribed physio program. Built for the AWS Builder Center "Always-On Agent" weekend challenge, treated as a portfolio piece, not deadline-driven.

## Non-negotiable boundary
This agent NEVER generates, suggests, or modifies clinical guidance. It does not recommend skipping, modifying, or substituting any exercise. Any flagged pain/symptom pattern gets compiled into a question for the physio, never a recommendation. If you're about to write logic that decides to skip or modify an exercise based on a symptom report, stop and flag it instead of building it. This is a hard design constraint, not a nice-to-have.

## Locked MVP spec
- **Input:** Marvin's actual prescribed program (exercises, sets/reps, per-side notes, 3–4x/week target). Loaded into the `Program` table and then maintained over time — not a static one-time load (see Program table below).
- **`Program` table (DynamoDB):** an evolving record of the plan, not a fixed seed. Each exercise row carries:
  - `status`: `active` or `retired`
  - `versionHistory`: list of dated changes to sets/reps/frequency
  - `retiredDate` / `retiredReason`: populated when an exercise is dropped
  - `progressedTo` / `progressedFrom`: links between exercises when one replaces another (e.g. step-down → Bulgarian split squat)
  - This is how a new program from the physio, a single exercise progressing, or a new exercise added mid-program all get handled without losing history. **Program changes are applied manually** — Marvin says when the physio updates the plan; nothing is auto-detected. Adherence and asymmetry logic must always filter on `status = active` to determine "the current program" at any point in time.
- **`Sessions` table (DynamoDB):** unchanged from original spec. Raw free-text note kept permanently alongside Bedrock's extracted tags. Single fixed partition, no GSI.
- **Logging:** simple form after each session, completed sets, per-side free-text note, pain/stiffness/confidence rating
- **AI step (Bedrock, Nova):** NLP tagging only. Extracts exercise, side, symptom type, severity from free-text notes. Classification, not recommendation.
- **Deterministic step (Lambda):** adherence tracking against the 3–4x/week target, side-asymmetry pattern detection across single-leg exercises, escalation compiler for flagged symptoms
- **Trigger:** EventBridge Scheduler, daily check for missed sessions (stale-thread pattern) plus event-triggered tagging on each session log (watcher pattern)
- **Storage:** DynamoDB
- **Frontend:** on-demand deep view — logging form, weekly visual trend view (mobility, pain, confidence), session-by-session comparison against previous workouts, full detail behind the weekly summary email
- **Reporting:** weekly and monthly summaries, therapist-ready format (formatted for Marvin to bring to/share at his own appointment — not an automated send-to-therapist feature). Summaries may surface trends — improving, plateauing, a rating trending the wrong way — and may prompt "bring this up with your physio." They **report the pattern only**: they never diagnose, never suggest a cause, and never imply *why* something is happening. This is the core non-negotiable boundary restated for trend narration, where the line blurs most easily. If you're about to write a summary that explains *why* a pattern is happening rather than just stating *that* it is happening, stop — that's over the line.
- **Delivery channels (both):** Email (SES) is the proactive push — daily missed-session nudge and weekly therapist-ready summary, emailed unprompted, no login required. Frontend is the on-demand deep view (trends, comparisons, detail).

## Explicitly out of scope
Clinical modification or exercise-skipping logic (hard exclusion, not just deferred), calendar awareness, wearable integration, computer vision form-checking, voice interface. Don't build these even if they seem like natural extensions.

Auto-parsing an updated program (PDF/email) into a diff against the `Program` table is a v2 idea, not in scope for this build. Don't build it even if it looks like a natural extension of the Phase 2 tagging pipeline — program changes are applied manually.

## Architecture pattern
Same split as the previous Ticket Triage project: **Bedrock does judgment (tagging), Lambda does math (adherence, asymmetry, escalation)**. Keep these as separate steps, not blended into one call, so the logic stays explainable and auditable.

## Reference repos (studied for pattern, not copied)
- `aws-samples/serverless-patterns` → `eventbridge-bedrock-s3-aoss`
- `aws-samples/sample-amazon-bedrock-ops-alert`

## Build discipline
- Work phases 0–7 in order. Don't start the next phase until the current one is live and verified, not just written.
- Verify every phase with a real, live test before marking it complete. No claiming something works without proof.
- If you deviate from this spec, document it here explicitly with the reason. Don't silently override a locked decision.
- If `sam deploy` fails on `CreateChangeSet`/transform permission errors, don't burn time debugging it, this hit the last project too. Pivot straight to raw CloudFormation (`aws cloudformation package` → `deploy`), the proven path.
- Default model: Nova Lite unless a task genuinely needs more.
- Bundler must target node22 explicitly; local Node version is not the deploy target. Every Lambda's CloudFormation `Runtime` is `nodejs22.x`.
- This file is living documentation. Update it as Phase 0 confirms environment details, and whenever reality diverges from the plan.

## Frontend auth (Phase 5)
The frontend (`web/`) is gated by a single shared secret sent as the `x-api-key` header — the same
secret both Function URLs check in-handler. The key **only ever comes from user input into
`localStorage`**; it is never hardcoded, never committed, and never bundled (proven by a `dist/`
grep for the literal value → zero matches). No key → only the "Enter access key" screen renders; any
`401` clears the stored key and re-shows that screen with an error, no silent retry. Function URLs
themselves are non-secret and live in `.env`. This is the app's real security boundary — treat it as
such when touching the frontend.

## Known limitations
- Email delivery confirmed working but not guaranteed to land in inbox — currently lands in spam due to no sender reputation/DKIM on the bare-address SES identity. See PROJECT_STATUS.md for full detail. Domain verification with DKIM would be the real fix, out of scope for this build.
- CORS on both Function URLs is locked to the production origin `https://rehab-recovery-agent.vercel.app` only. Vercel **preview** deployments get their own random domains and are intentionally **not** allowlisted — they'll be CORS-blocked against the live backend. Deliberate for a single-developer project (a `*.vercel.app` match would defeat the lock); add an exact preview origin temporarily if ever needed. See PROJECT_STATUS.md Phase 5 Part B.
- Sessions are keyed by date (`SK = YYYY-MM-DD`), so logging twice for the same date is a **full-item overwrite, not a merge**. Any live write test MUST use a throwaway date; PITR is the recovery net (proven in Phase 5 Part B) but the primary guard is not writing test payloads to a real date.

## Status
See PROJECT_STATUS.md for phase findings, environment details, and decision log.
