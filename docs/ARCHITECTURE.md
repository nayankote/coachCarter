# CoachCarter — Product Architecture

**Last updated:** 2026-03-22

---

## Overview

CoachCarter is an automated triathlon coaching system. It syncs workouts from Garmin, scores them against a structured training plan, emails the athlete for feedback, uses Claude AI to generate coaching reports, and presents everything in a static dashboard.

---

## End-to-End Data Flow

```
Garmin Connect
      │
      ▼ scripts/sync-garmin.js (run on-demand locally)
      │  • Fetches new activities via ID-set comparison (pages of 10)
      │  • Splits multi-sport races into per-leg rows
      │  • Deduplicates duplicate bike recordings
      │  • Uploads FIT file → Supabase Storage
      │  • Inserts workout row (status: synced)
      │
      ▼ scripts/analyze-workout.js (called immediately after sync)
      │  • Parses FIT file → extracts sport-specific metrics
      │  • Matches workout to plan session (day + sport)
      │  • Scores compliance against plan targets (0–100)
      │  • Sends feedback-request email via AgentMail
      │  • Updates workout (status: awaiting_feedback)
      │
      ▼ Athlete replies to email
      │
      ▼ Supabase Edge Function (AgentMail webhook)
      │
      ▼ scripts/finalize-coaching.js
      │  • Strength: Claude extracts structured compliance from reply
      │  • All sports: Claude generates 4–6 sentence coaching report
      │  • Emails coaching report back to athlete
      │  • Updates workout (status: complete)
      │
      ▼ scripts/build-frontend-data.js (GitHub Actions, every 30 min)
      │  • Fetches all workouts from Supabase
      │  • Strips raw email content from feedback field
      │  • Writes docs/workouts.json + docs/plan.json
      │  • Commits back to repo
      │
      ▼ GitHub Pages → docs/index.html
         Static dashboard — reads workouts.json, no backend calls
```

---

## Components

### Garmin Sync — `scripts/sync-garmin.js`

- Loads all known `garmin_activity_id`s from Supabase into a Set
- Fetches Garmin activities newest-first in pages of 10; stops when a full page is already known
- **Multi-sport races** (e.g. 70.3 Ironman): single FIT file split into per-leg rows (swim, T1, bike, T2, run) using synthetic IDs (`parentId * 10 + sessionIndex`)
- **Bike dedup**: if a bike already exists on the same date whose time window overlaps the new activity, skips as duplicate (handles Zwift + watch recording the same ride simultaneously). Back-to-back rides on the same day are kept since their time windows don't overlap.
- Calls `analyze-workout` immediately for each new activity
- `retryStuck`: on each run, retries any rows stuck in `status: synced` for >10 min

### Analysis — `scripts/analyze-workout.js`

- Downloads FIT file from Supabase Storage
- Extracts metrics via `lib/fit-parser.js`
- Matches to plan session via `lib/plan.js`
- Scores compliance via `lib/compliance.js`
- Sends feedback-request email via `lib/email.js`
- Saves metrics + plan match to DB; sets `status: awaiting_feedback`

### FIT Parser — `lib/fit-parser.js`

| Sport | Metrics extracted |
|---|---|
| Bike | Avg power, NP (30s rolling), VI, IF, TSS, power zones, interval detection, HR drift, distance |
| Run | Avg pace (sec/km), rTSS, HR drift, distance |
| Swim | Avg pace from active lengths (sec/100m), sTSS, distance |
| Strength | Duration, calories only |
| Multi-sport | `getMultiSportSessions()` returns per-leg index/sport/duration; `sessionIndex` param selects correct session from multi-session FIT |

### Compliance Scoring — `lib/compliance.js`

Weighted pass/fail per factor → score 0–100.

| Sport | Factors |
|---|---|
| Bike | Intervals completed, NP in target range, VI ≤ max, duration ±15% |
| Run | Avg pace in range, avg HR ≤ max, duration ±15% |
| Swim | Pace vs CSS target (±5s), total distance ≥ 95% of target |
| Strength | Scored from email reply by Claude (not from FIT data) |

### Coaching AI — `lib/coaching.js`

All calls use `claude-sonnet-4-6`.

| Function | Purpose |
|---|---|
| `generateCoachingReport` | Per-workout coaching note (4–6 sentences, blunt, data-led) |
| `generateStrengthCompliance` | Extracts structured compliance JSON from athlete's email reply |
| `generateWeeklyReport` | 3–5 paragraph weekly summary with trend vs prior week |

Athlete context passed on every call: FTP, LTHR, run threshold pace, swim CSS.

### Email — `lib/email.js` + `lib/email-templates.js`

- Sends via **AgentMail** API (not Gmail/SMTP)
- Sport-specific templates include actual vs target metrics
- Replies threaded via `reply_to_message_id`
- AgentMail webhook triggers Supabase Edge Function on reply

### Garmin Client — `lib/garmin.js`

- `createGarminClient()`: authenticates with Garmin Connect via the unofficial SSO (`garmin-connect` npm package); 2s delay post-auth to avoid immediate rate limiting
- `getNewActivities(client, knownIds)`: pages through Garmin activities newest-first (10 per page, 1s between pages); stops when a full page is all-known
- `fetchWithRetry`: wraps `getActivities` with 3-attempt retry on 429 (10s / 20s backoff)
- `downloadFitFile(client, activityId)`: downloads activity ZIP, extracts the `.fit` entry
- `deduplicateBikes(activities)`: within a single sync batch, prefers Zwift (`virtual_ride` typeKey) over watch when both arrive in the same run; keeps all if source is ambiguous

### Secrets — `lib/keychain.js`

Unified secret resolution — checks env vars first (for CI), falls back to macOS Keychain (for local runs):

| Keychain service | Env var fallback | Used by |
|---|---|---|
| `coachcarter-anthropic` | `ANTHROPIC_API_KEY` | `lib/coaching.js` |
| `coachcarter-garmin` | `GARMIN_PASSWORD` | `lib/garmin.js` |
| `coachcarter-agentmail` | `AGENTMAIL_API_KEY` | `lib/email.js` |
| `coachcarter-supabase` | `SUPABASE_SERVICE_KEY` | `lib/supabase.js` |
| `coachcarter-gmail` | `GMAIL_APP_PASSWORD` | (legacy, unused) |

### Supabase Client — `lib/supabase.js`

Singleton `createClient` wrapper. Reads `SUPABASE_URL` from env, service key via `lib/keychain.js`. All scripts call `getSupabase()` to get the shared client instance.

### Plan — `lib/plan.js`

- Reads `plan.json` — 4-week rotating training block
- `calcPlanWeek(planStartDate, activityDate)`: maps any date → week 1–4 (cycles indefinitely)
- `matchSession(plan, week, dayOfWeek, sport)`: finds prescribed session

### Finalize Coaching — `scripts/finalize-coaching.js`

Triggered by Supabase Edge Function when athlete replies:
1. Strength only: Claude extracts compliance from reply text
2. All sports: Claude generates coaching report
3. Emails coaching report back to athlete (threaded reply)
4. Sets `status: complete`

### Weekly Review — `scripts/weekly-review.js`

- Runs every **Sunday 8pm IST** via GitHub Actions
- Compares completed sessions vs plan for the week
- Fetches prior week compliance from `weekly_summaries` table for trend
- Claude writes summary → emailed to athlete
- Stores to `weekly_summaries` table

### Frontend — `docs/index.html`

- Fully static (no Supabase calls from browser)
- All weeks rendered vertically, scrolls to current week on load
- **Card colours**: green ≥80%, yellow 50–79% or awaiting feedback, red <50% or missed past date, white = future
- **Ticks**: ✓ grey = awaiting feedback, ✓✓ blue = complete
- Weekly stats (planned vs actual per sport) shown only for weeks that have started
- Duration format: `Xh Ymin` (e.g. "1h 15min", "30min")

---

## Infrastructure

| Layer | Technology |
|---|---|
| Database | Supabase Postgres (RLS enabled on all tables) |
| File storage | Supabase Storage (`fit-files` bucket) |
| Email send/receive | AgentMail |
| Reply webhook | Supabase Edge Function |
| AI coaching | Anthropic Claude (`claude-sonnet-4-6`) |
| Secrets | macOS Keychain (local); GitHub Actions Secrets (CI) |
| Garmin sync | Local Mac, on-demand (`node scripts/sync-garmin.js`) |
| Weekly review | GitHub Actions (Sunday 8:30pm IST) |
| Frontend build | GitHub Actions (every 30 min + on push to main) |
| Frontend hosting | GitHub Pages (from `/docs`) |

---

## Database Tables

| Table | Purpose |
|---|---|
| `workouts` | One row per activity (or per leg for multi-sport). Holds metrics, compliance, coaching report, feedback, status. |
| `weekly_summaries` | One row per week. Holds compliance average, session counts, Claude summary. |
| `sync_state` | Legacy — no longer used. Safe to drop. |

### Workout Status Lifecycle

```
synced → analyzing → awaiting_feedback → complete
```

---

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `build-frontend.yml` | Push to main + every 30 min | Rebuilds `workouts.json` / `plan.json`, commits to repo |
| `weekly-review.yml` | Sunday 14:30 UTC (8pm IST) + manual | Sends weekly coaching summary email |
| `sync-garmin.yml` | Manual (`workflow_dispatch`) only | Legacy — sync now runs locally |

---

## Known Gaps / Tech Debt

| Item | Notes |
|---|---|
| Garmin sync is manual | Cron removed (Garmin rate-limits datacenter IPs). Run locally as needed. |
| `sync_state` table | Unused legacy table. Safe to drop from Supabase. |
| `scripts/update-plan.js` | Plan validator — run manually after editing `plan.json` to catch missing fields. Not wired into CI. |
| `scripts/test-agentmail-e2e.js` | Test script only — not part of production flow. |
| `pollReplies` in `lib/email.js` | Deprecated, kept to avoid import errors. Remove after confirming Edge Function handles all replies. |
