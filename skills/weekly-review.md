---
name: weekly-review
description: Generate and send the weekly training summary
trigger: cron, Sunday 20:00
---

# /weekly-review

Generates a weekly coaching summary comparing completed sessions against plan.json, then sends it by email and records it in weekly_summaries.

## Steps

1. Run:
   ```bash
   cd coachCarter && node scripts/weekly-review.js
   ```

2. Report: plan_week, sessions completed vs missed, overall compliance percentage, confirm email sent.
