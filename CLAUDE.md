# CLAUDE.md — Recovery Adherence & Asymmetry Watcher

## What this is
An always-on AWS agent that organizes, reminds, tracks, and summarizes Marvin's prescribed physio program. Built for the AWS Builder Center "Always-On Agent" weekend challenge, treated as a portfolio piece, not deadline-driven.

## Non-negotiable boundary
This agent NEVER generates, suggests, or modifies clinical guidance. It does not recommend skipping, modifying, or substituting any exercise. Any flagged pain/symptom pattern gets compiled into a question for the physio, never a recommendation. If you're about to write logic that decides to skip or modify an exercise based on a symptom report, stop and flag it instead of building it. This is a hard design constraint, not a nice-to-have.

## Locked MVP spec
- **Input:** Marvin's actual prescribed program (exercises, sets/reps, per-side notes, 3–4x/week target), loaded once
- **Logging:** simple form after each session, completed sets, per-side free-text note, pain/stiffness/confidence rating
- **AI step (Bedrock, Nova):** NLP tagging only. Extracts exercise, side, symptom type, severity from free-text notes. Classification, not recommendation.
- **Deterministic step (Lambda):** adherence tracking against the 3–4x/week target, side-asymmetry pattern detection across single-leg exercises, escalation compiler for flagged symptoms
- **Trigger:** EventBridge Scheduler, daily check for missed sessions (stale-thread pattern) plus event-triggered tagging on each session log (watcher pattern)
- **Storage:** DynamoDB
- **Frontend:** on-demand deep view — logging form, weekly visual trend view (mobility, pain, confidence), session-by-session comparison against previous workouts, full detail behind the weekly summary email
- **Reporting:** weekly summary, therapist-ready format (formatted for Marvin to bring to/share at his own appointment — not an automated send-to-therapist feature)
- **Delivery channels (both):** Email (SES) is the proactive push — daily missed-session nudge and weekly therapist-ready summary, emailed unprompted, no login required. Frontend is the on-demand deep view (trends, comparisons, detail).

## Explicitly out of scope
Clinical modification or exercise-skipping logic (hard exclusion, not just deferred), calendar awareness, wearable integration, computer vision form-checking, voice interface. Don't build these even if they seem like natural extensions.

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

## Status
See PROJECT_STATUS.md for phase findings, environment details, and decision log.
