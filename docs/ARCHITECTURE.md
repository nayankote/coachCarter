# CoachCarter — Product Architecture

**Last updated:** 2026-03-22

> This document describes the system as it exists today. Planned features and bugs are tracked in [GitHub Issues](https://github.com/nayankote/coachCarter/issues).

---

## Overview

CoachCarter is an automated triathlon coaching system. It syncs workouts from Garmin, scores them against a structured training plan, collects athlete feedback over email, uses Claude AI to generate coaching reports, and presents everything in a static dashboard.

---

## End-to-End Data Flow

```
Garmin Connect
      │
      ▼ scripts/sync-garmin.js  (run on-demand, locally)
      │  • Fetches new activities via ID-set comparison (pages of 10)
      │  • Splits multi-sport races into per-leg rows
      │  • Deduplicates concurrent bike recordings (Zwift + watch)
      │  • Uploads FIT file → Supabase Storage
      │  • Inserts workout row (status: synced)
      │
      ▼ scripts/analyze-workout.js  (called immediately after sync)
      │  • Parses FIT file → extracts sport-specific metrics
      │  • Matches workout to plan session (day + sport)
      │  • Scores compliance against plan targets (0–100)
      │  • Sends feedback-request email via AgentMail
      │  • Updates workout (status: awaiting_feedback)
      │
      ▼ Athlete replies to email
      │
      ▼ Supabase Edge Function  (AgentMail webhook)
      │
      ▼ scripts/finalize-coaching.js
      │  • Strength: Claude extracts structured compliance from reply
      │  • All sports: Claude generates 4–6 sentence coaching report
      │  • Emails coaching report back to athlete (threaded)
      │  • Updates workout (status: complete)
      │
      ▼ scripts/build-frontend-data.js  (GitHub Actions, every 30 min)
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

### `scripts/sync-garmin.js` — Garmin Sync

- Loads all known `garmin_activity_id`s from Supabase into a Set
- Fetches Garmin activities newest-first in pages of 10; stops when a full page is entirely known
- **Multi-sport races** (e.g. 70.3 Ironman): single FIT file split into per-leg rows (swim, T1, bike, T2, run) using synthetic IDs (`parentId * 10 + sessionIndex`)
- **Bike dedup**: if a bike already exists on the same date whose time window overlaps the new activity, skips it as a duplicate. Handles Zwift + watch recording the same ride simultaneously; back-to-back rides on the same day are kept since their time windows don't overlap.
- Calls `analyze-workout` immediately after inserting each new activity
- `retryStuck`: on each run, retries any rows stuck in `status: synced` for >10 min

### `scripts/analyze-workout.js` — Post-Sync Analysis

- Downloads FIT file from Supabase Storage
- Extracts metrics via `lib/fit-parser.js`
- Matches to plan session via `lib/plan.js`
- Scores compliance via `lib/compliance.js`
- Sends feedback-request email via `lib/email.js`
- Saves metrics + plan match to DB; sets `status: awaiting_feedback`

### `scripts/finalize-coaching.js` — Post-Feedback Coaching

Triggered by Supabase Edge Function when athlete replies to the feedback email:
1. Strength only: Claude extracts structured compliance from reply text
2. All sports: Claude generates a coaching report
3. Emails the coaching report back to athlete as a threaded reply
4. Sets `status: complete`

### `scripts/weekly-review.js` — Weekly Summary

- Runs every **Sunday 8pm IST** via GitHub Actions
- Compares completed sessions vs plan for the week
- Fetches prior week compliance from `weekly_summaries` for trend analysis
- Claude writes a 3–5 paragraph summary → emailed to athlete
- Stores result to `weekly_summaries` table

### `scripts/build-frontend-data.js` — Frontend Data Build

- Runs on every push to `main` and every 30 minutes via GitHub Actions
- Fetches all workouts from Supabase, sanitises the raw feedback field
- Writes `docs/workouts.json` and `docs/plan.json`
- Commits updated files back to the repo

### `scripts/update-plan.js` — Plan Validator

Run manually after editing `plan.json` to catch structural errors before they affect sync or analysis. Not wired into CI.

---

## Libraries

### `lib/garmin.js`

- `createGarminClient()`: authenticates with Garmin Connect via unofficial SSO; 2s post-auth delay to avoid rate limiting
- `getNewActivities(client, knownIds)`: pages through activities newest-first, 1s between pages, stops when a full page is already known
- `fetchWithRetry`: 3-attempt retry on HTTP 429 with 10s / 20s backoff
- `downloadFitFile(client, activityId)`: downloads activity ZIP and extracts the `.fit` entry
- `deduplicateBikes(activities)`: within a single sync batch, prefers Zwift (`virtual_ride` typeKey) over watch; keeps all if source is ambiguous

### `lib/fit-parser.js`

Parses binary FIT files using `fit-file-parser`. Extracts sport-specific metrics:

| Sport | Metrics |
|---|---|
| Bike | Avg power, NP (30s rolling avg), VI, IF, TSS, power zones (Z1–Z5), interval detection, HR drift, distance |
| Run | Avg pace (sec/km), rTSS, HR drift, distance |
| Swim | Avg pace from active lengths (sec/100m), sTSS, distance |
| Strength | Duration, calories only |
| Multi-sport | `getMultiSportSessions()` returns per-leg metadata; `sessionIndex` selects the correct session from multi-session FIT files |

### `lib/compliance.js`

Weighted pass/fail scoring per factor → 0–100.

| Sport | Factors scored |
|---|---|
| Bike | Intervals completed, NP in target range, VI ≤ max, duration ±15% |
| Run | Avg pace in range, avg HR ≤ max, duration ±15% |
| Swim | Pace vs CSS target (±5s), total distance ≥ 95% of target |
| Strength | Scored from email reply by Claude, not FIT data |

### `lib/coaching.js`

All calls use `claude-sonnet-4-6`. Athlete context (FTP, LTHR, run threshold, swim CSS) is included on every call.

| Function | Purpose |
|---|---|
| `generateCoachingReport` | Per-workout note: 4–6 sentences, data-led, blunt |
| `generateStrengthCompliance` | Extracts structured compliance JSON from athlete's email reply |
| `generateWeeklyReport` | 3–5 paragraph weekly summary with trend vs prior week |

### `lib/email.js` + `lib/email-templates.js`

- Sends via **AgentMail** API
- Sport-specific templates include actual vs target metrics inline
- Replies threaded via `reply_to_message_id`
- AgentMail webhook triggers the Supabase Edge Function on reply

### `lib/plan.js`

- Reads `plan.json` — a 4-week rotating training block
- `calcPlanWeek(planStartDate, activityDate)`: maps any date → week 1–4, cycling indefinitely
- `matchSession(plan, week, dayOfWeek, sport)`: returns the matching prescribed session or null

### `lib/keychain.js`

Unified secret resolution: checks env vars first (for CI), falls back to macOS Keychain (for local runs).

| Keychain service | Env var | Used by |
|---|---|---|
| `coachcarter-anthropic` | `ANTHROPIC_API_KEY` | `lib/coaching.js` |
| `coachcarter-garmin` | `GARMIN_PASSWORD` | `lib/garmin.js` |
| `coachcarter-agentmail` | `AGENTMAIL_API_KEY` | `lib/email.js` |
| `coachcarter-supabase` | `SUPABASE_SERVICE_KEY` | `lib/supabase.js` |

### `lib/supabase.js`

Singleton Supabase client. Reads `SUPABASE_URL` from env, service key via `lib/keychain.js`. All scripts call `getSupabase()`.

---

## Frontend — `docs/index.html`

Fully static — no Supabase calls from the browser. All data comes from `workouts.json`.

- All training weeks rendered vertically; page scrolls to the current week on load
- **Card colours**: green ≥80% compliance, yellow 50–79% or awaiting feedback, red <50% or missed past date, white = future session
- **Status ticks**: ✓ grey = awaiting feedback, ✓✓ blue = complete
- Weekly planned vs actual stats shown only for weeks that have already started
- Duration format: `Xh Ymin` (e.g. "1h 15min", "30min")

---

## Infrastructure

| Layer | Technology |
|---|---|
| Database | Supabase Postgres (RLS enabled) |
| File storage | Supabase Storage (`fit-files` bucket) |
| Email send/receive | AgentMail |
| Reply webhook | Supabase Edge Function |
| AI coaching | Anthropic Claude (`claude-sonnet-4-6`) |
| Secrets (local) | macOS Keychain |
| Secrets (CI) | GitHub Actions Secrets |
| Garmin sync | Local Mac, on-demand |
| Weekly review | GitHub Actions (Sunday 14:30 UTC) |
| Frontend build | GitHub Actions (every 30 min + on push to `main`) |
| Frontend hosting | GitHub Pages (`/docs`) |

---

## Database

### Tables

| Table | Purpose |
|---|---|
| `workouts` | One row per activity (or per leg for multi-sport). Holds raw metrics, compliance score, coaching report, athlete feedback, and status. |
| `weekly_summaries` | One row per completed week. Holds compliance average, session counts, and Claude-generated summary. |

### Workout Status Lifecycle

```
synced → analyzing → awaiting_feedback → complete
```

---

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `build-frontend.yml` | Push to `main` + every 30 min | Rebuilds `workouts.json` / `plan.json`, commits to repo |
| `weekly-review.yml` | Sunday 14:30 UTC + manual | Generates and emails weekly coaching summary |
| `sync-garmin.yml` | Manual (`workflow_dispatch`) only | Kept for emergency manual trigger; sync runs locally day-to-day |
