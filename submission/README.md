# Submission package — Mull

Team: Mohit Singh (Engineer) · Lay Naik (PM) · Saaketh Koduri (Sales)

Mull is a macOS voice layer. One key dictates on-device; the other sends a
request to a model, and every change it proposes is previewed and can be
undone. The product, architecture and safety model are in the root
[README](../README.md).

## Where each required deliverable is

| Deliverable | File |
|---|---|
| Working product: one-command run | `npm run setup` (root [README](../README.md) "Getting started"); no Mac: `npm ci && npm run verify` |
| Architecture | [README](../README.md) "Architecture", [docs/05-electron-architecture.md](../docs/05-electron-architecture.md), [docs/DEVELOPER-GUIDE.md](../docs/DEVELOPER-GUIDE.md) |
| Tests and generated evidence | `npm test` (1,071 tests); outputs in [evidence/](../evidence/): test run, typecheck, smoke, latency ledger |
| Reliability, security, data handling | [README](../README.md) "The safety model", "Permissions"; [AI_DISCLOSURE.md](AI_DISCLOSURE.md) §2 (what leaves the Mac) |
| Observability | per-utterance trace log (`src/main/trace.ts`), latency ledger (`src/main/bench.ts`, `npm run bench:report`), journal of every action |
| Business Model Canvas | [BUSINESS_MODEL_CANVAS.md](BUSINESS_MODEL_CANVAS.md) |
| Pricing and go-to-market | [PRICING.md](PRICING.md) |
| Real users and decision traces | [research/USER_TRACES.md](research/USER_TRACES.md) |
| Stakeholder/client interviews | [research/INTERVIEW_SCRIPT.md](research/INTERVIEW_SCRIPT.md) (users), [research/BUYER_INTERVIEW_SCRIPT.md](research/BUYER_INTERVIEW_SCRIPT.md) (buyers and approvers), [research/INTERVIEWS.md](research/INTERVIEWS.md) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| Pitch deck | `PITCH_DECK.pdf` |
| Decision log | [DECISION_LOG.md](DECISION_LOG.md) |
| AI-collaboration disclosure | [AI_DISCLOSURE.md](AI_DISCLOSURE.md) |
| Third-party credits | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| Role evidence | `../ROLE_EVIDENCE_<name>.md`, one per learner |
| Market research (background) | [docs/REPORT.md](../docs/REPORT.md), [docs/01](../docs/01-alma-deep-dive.md)–[04](../docs/04-positioning-business-model.md) |

## Building the archive

```bash
bash scripts/pack-submission.sh First_Last   # → ../Mull_submission_First_Last.zip
```

The script takes only what git would ship, plus the competitor DMG exclusion.
It then checks the result:

- forbidden paths;
- credential-shaped strings;
- the 500 MB limit;
- the learner's role-evidence file;
- open placeholders.
