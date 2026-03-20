---
name: update-plan
description: Update plan.json from conversation — sessions, targets, or athlete thresholds
trigger: manual
---

# /update-plan

Updates the training plan in plan.json. Use this when a coaching report suggests an adjustment, when starting a new training block, or when athlete thresholds change (e.g. after a ramp test).

## Steps

1. Understand what to change — ask for specifics if unclear.

2. Read the current plan:
   ```bash
   cat coachCarter/plan.json
   ```

3. Make the targeted edit directly to plan.json using the Edit tool.

4. Validate:
   ```bash
   cd coachCarter && node scripts/update-plan.js
   ```

5. Commit:
   ```bash
   git add coachCarter/plan.json
   git commit -m "plan: <describe what changed and why>"
   ```

6. Report: what changed and which sessions or targets were affected.

## Rules
- Session `id` values must stay stable — they are stored in the workouts table as `plan_session_id`
- Never remove a week that has already started; only add or modify future sessions
- Athlete thresholds (`ftp`, `lthr`, `run_threshold_sec_per_km`, `swim_css_sec_per_100m`) live under `plan.athlete` — update after a ramp test or threshold test
