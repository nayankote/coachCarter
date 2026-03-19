---
name: sync-garmin
description: Sync new workouts from Garmin Connect and trigger analysis
trigger: cron every 4 hours, or manual
---

# /sync-garmin

Downloads new FIT files from Garmin Connect, stores them in Supabase, then calls /analyze-workout for each new activity.

## Steps

1. Run the sync script:
   ```bash
   cd coachCarter && node scripts/sync-garmin.js
   ```

2. The script prints each activity ID it stored. For each one, call:
   ```
   /analyze-workout {id}
   ```
   Also retry any rows logged as "stuck".

3. Report: how many activities synced, any errors encountered.

## Notes
- All credentials come from macOS Keychain — never from .env
- Indoor bike sessions may produce two activities (Zwift + watch). The script deduplicates automatically when the source is identifiable. If not, both are kept and analyzed separately.
- If Garmin auth fails, the session token may have expired. Re-run the script — it will re-authenticate.
