Generate and send the weekly training summary email.

```bash
node scripts/weekly-review.js
```

This will:
1. Fetch all workouts for the current plan week from Supabase
2. Compare completed sessions vs plan (sessions done, missed, avg compliance)
3. Fetch prior week's data from `weekly_summaries` for trend analysis
4. Call Claude to write a 3–5 paragraph coaching summary
5. Email the summary to the athlete via AgentMail
6. Store the result in the `weekly_summaries` table

Report: plan_week, sessions completed vs missed, avg compliance, confirm email sent.

## Notes
- Runs automatically every Sunday at 14:30 UTC via GitHub Actions (`weekly-review.yml`)
- Can be triggered manually via `workflow_dispatch` in GitHub Actions
- Credentials: `SUPABASE_URL` from `.env`, secrets from macOS Keychain (`coachcarter-supabase`, `coachcarter-agentmail`, `coachcarter-anthropic`)
