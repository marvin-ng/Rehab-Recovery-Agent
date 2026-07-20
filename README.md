# Rehab-Recovery-Agent

An always-on AWS agent that organizes, reminds, tracks, and summarizes a prescribed physio
program. Log a session, and the agent tags your free-text notes (exercise, side, symptom,
severity) with Amazon Bedrock (Nova Lite), then runs deterministic Lambda logic for adherence
tracking against a 3–4x/week target, side-asymmetry detection across single-leg exercises, and a
symptom-escalation compiler. It pushes a daily missed-session nudge and a weekly therapist-ready
summary by email (SES), and offers an on-demand frontend for trends and session-by-session
comparison.

**Design boundary:** the agent never generates, suggests, or modifies clinical guidance. Flagged
symptoms are compiled into questions for the physio — never recommendations. Bedrock does the
judgment (tagging); Lambda does the math (adherence, asymmetry, escalation).

Built for the AWS Builder Center "Always-On Agent" challenge.

See [CLAUDE.md](CLAUDE.md) for the full spec and boundaries, and
[PROJECT_STATUS.md](PROJECT_STATUS.md) for phase findings and the decision log.
