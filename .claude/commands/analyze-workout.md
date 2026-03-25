Re-analyze a synced workout: parse FIT metrics, match to plan, score compliance, send feedback email.

Usage: /analyze-workout {workout_id}

```bash
node scripts/analyze-workout.js {workout_id}
```

This will:
1. Download the FIT file from Supabase Storage
2. Extract sport-specific metrics (pace via `enhanced_speed` for runs, NP/TSS for bike, pace per 100m for swim)
3. Match to the plan session by day + sport
4. Score compliance (0–100) against plan targets
5. Send a feedback-request email via AgentMail
6. Update the workout row (status: awaiting_feedback)

Report: sport, matched plan_session_id, compliance_score, confirm email sent.

## Notes
- Strength sessions get `compliance_score = null` — scored later by Claude from the athlete's email reply
- Unplanned activities are tagged `plan_session_id = "unplanned"` and still get a feedback email
- If the workout is already `awaiting_feedback` or `complete`, reset it to `synced` in Supabase first
- Credentials: `SUPABASE_URL` from `.env`, secrets from macOS Keychain (`coachcarter-supabase`, `coachcarter-agentmail`, `coachcarter-anthropic`)
