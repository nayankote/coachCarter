Update the training plan in plan.json.

Use when: coaching report suggests an adjustment, starting a new training block, athlete thresholds change (after a ramp test), or manually progressing strength sessions.

## Steps

1. Understand what to change — ask for specifics if unclear.

2. Read the current plan:
   ```bash
   cat plan.json
   ```

3. Make the targeted edit to `plan.json` using the Edit tool.

4. Validate structure:
   ```bash
   node scripts/update-plan.js
   ```

5. Commit and push:
   ```bash
   git add plan.json
   git commit -m "plan: <describe what changed and why>"
   git pull --rebase && git push
   ```

6. Report what changed and which sessions or targets were affected.

## Rules
- Session `id` values must stay stable — stored in the workouts table as `plan_session_id`
- Never remove a week that has already started; only add or modify future sessions
- Athlete thresholds (`ftp`, `lthr`, `run_threshold_sec_per_km`, `swim_css_sec_per_100m`) live under `plan.athlete`
- Strength sessions: do NOT add progression without explicit athlete approval — currently kept flat (same sets/reps all weeks) until athlete is confident
- Always `git pull --rebase` before pushing — GitHub Actions may have committed workouts.json since last pull
