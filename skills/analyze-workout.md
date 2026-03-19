---
name: analyze-workout
description: Parse FIT file, match to plan, score compliance, send feedback email
trigger: automatic after /sync-garmin, or manual
---

# /analyze-workout {id}

Analyzes a synced workout: parses FIT metrics, matches to plan.json, scores compliance, and sends a feedback email.

## Steps

1. Run:
   ```bash
   cd coachCarter && node scripts/analyze-workout.js {id}
   ```

2. Report: sport, plan_session_id, compliance_score, and confirm email was sent.

3. If the script errors, check:
   - `SUPABASE_URL` is set in `.env`
   - All Keychain secrets exist (`coachcarter-supabase`, `coachcarter-gmail`)
   - `plan.json` weeks are populated (empty weeks array → all sessions tagged `unplanned`)

## Notes
- Strength sessions get `compliance_score = null` until `/finalize-coaching` runs after email reply
- Unplanned activities are tagged `plan_session_id = "unplanned"` and still receive a feedback email
