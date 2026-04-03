Evaluate the upcoming week's plan and propose adjustments if needed.

```bash
node scripts/evaluate-plan.js
```

This will:
1. Load the full athlete context (global + 28-day rolling window)
2. Evaluate next week's sessions against current load, sleep, and compliance trends
3. Apply the Plan Stability Doctrine — only propose changes if triggers are met
4. If a proposal is generated, email it to the athlete and store in plan_proposals table
5. If no changes needed, send a confirmation message and exit

Report: plan_week, whether a proposal was generated, confirmation sent.

## Proposal Workflow
When a proposal is accepted by the athlete (via email reply):
1. The on-reply Edge Function marks the proposal as 'approved' in plan_proposals
2. Use /update-plan to make the actual plan.json changes based on the accepted proposal
3. Reference the plan_proposals row for what was agreed

## Notes
- Runs automatically every Sunday at 15:30 UTC (9pm IST) via GitHub Actions
- Can be triggered manually via `workflow_dispatch` or this command
- Runs after the weekly review (14:30 UTC) so the athlete has context
- Credentials: `SUPABASE_URL` from `.env`, secrets from macOS Keychain
