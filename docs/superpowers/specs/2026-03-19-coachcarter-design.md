# CoachCarter — Design Spec
**Date:** 2026-03-19
**Status:** Draft v4
**Scope:** Step 1 (Garmin Sync) + Step 2 (Match & Analyze)

---

## Overview

CoachCarter is a personal triathlon training tracker powered by Claude Code. It has two layers:

- **CLI (Claude Code skills)** — the intelligence layer. Syncs workouts from Garmin, analyzes FIT files, sends email feedback requests, writes coaching reports, updates the training plan.
- **Web dashboard** — a read-only view (Step 3, out of scope here) showing a compliance calendar: green for completed, red for missed, blank for pending.

The current training block is a **post-race offseason plan** that began March 17, 2026, following Ironman 70.3 Oman (Feb 14, 2026). It is a 4-week repeating block (Base Build → Progression → Peak Load → Deload) that cycles until the next race target is defined.

---

## Athlete Profile

```
FTP: 190W
Weight: 72kg
LTHR: 165bpm
Run Threshold: 4:50/km (290 sec/km)
Swim CSS: 3:00/100m (180 sec/100m)
Plan start: 2026-03-17 (4-week repeating block)
```

---

## Training Plan Structure

The plan lives at `coachCarter/plan.json`. It is the source of truth for prescriptions. Claude Code updates this file directly when the plan changes. The skills are plan-agnostic: they read whatever sessions are defined in `plan.json` and match/score against those targets — no sport-specific logic is hardcoded outside the file. Weeks 2–4 must be populated in `plan.json` before `/analyze-workout` can score compliance for those weeks — until then, those sessions are tagged `unplanned` gracefully.

### FIT Data by Sport

The amount of data extracted from a FIT file depends on sport type, not on which day the session falls:

| Sport | FIT data available |
|-------|--------------------|
| Bike | Full (power, HR, intervals) |
| Run | Full (pace, HR, efficiency) |
| Swim | Full (pace, distance) |
| Strength | Time + calories only — email reply fills the compliance gap |

The current weekly session schedule will be defined in `plan.json. It is not encoded in the spec.

### plan.json Schema

The actual session schedule and prescriptions live in `plan.json` — not in this spec. The schema below shows the field structure only; values are filled in per training block.

```json
{
  "plan_name": "string",
  "plan_start_date": "YYYY-MM-DD",
  "athlete": {
    "ftp": "number (watts)",
    "weight": "number (kg)",
    "lthr": "number (bpm)",
    "run_threshold_sec_per_km": "number",
    "swim_css_sec_per_100m": "number"
  },
  "weeks": [
    {
      "week": "1–4",
      "label": "string (e.g. Base Build)",
      "sessions": [
        {
          "id": "string (unique, used as plan_session_id in workouts table)",
          "day": "Monday | Tuesday | ... | Sunday",
          "sport": "bike | run | swim | strength",
          "type": "string (e.g. intervals, z2, technique, easy, A, B)",
          "duration_min": "number",
          "targets": {
            "// bike": "power_min, power_max, vi_max, tss_target, warmup, main_set, cooldown",
            "// run":  "pace_min_sec, pace_max_sec, hr_max, zone",
            "// swim": "total_distance_m, css_target_sec_per_100m, main_set",
            "// strength": "exercises (name, sets, reps, per_side), mobility_min, mobility_focus"
          },
          "coaching_notes": "string"
        }
      ]
    }
  ]
}
```

Each week in the 4-week block follows this structure. The skills read `plan.json` dynamically — adding, removing, or reordering sessions requires no code changes.

---

## Step 1: Garmin Sync

### How It Works

Garmin auto-uploads to Garmin Connect after every session. The `/sync-garmin` skill polls Garmin Connect via the `garmin-connect` npm library, downloads the raw FIT file, and stores it in Supabase. Runs on a Claude Code cron every 4 hours.

**Duplicate bike activities (Zwift + watch):** Indoor bike sessions produce two Garmin Connect activities — one from Zwift (Wahoo Kickr Core power, accurate) and one from the Garmin watch (power underestimated). At sync time, check each activity's source application field. If the library exposes it, prefer the Zwift-sourced activity and skip the watch duplicate. If the source field is unavailable, sync both activities as separate rows — each is analyzed independently and both appear in the coaching report. No power-based deduplication is performed.

### Skill: `/sync-garmin`

```
1. Read last_synced_at from sync_state table
2. Authenticate with Garmin Connect (session token from macOS Keychain)
3. Fetch all activities since last_synced_at
4. For each new activity:
   a. Download raw .FIT file
   b. Upload to Supabase Storage: fit-files/{YYYY-MM-DD}_{sport}_{garmin_id}.fit
   c. Insert row into workouts table with status = "synced"
   d. Call /analyze-workout {id} inline (synchronously, within the same skill run)
      — if /analyze-workout fails, the row stays at status="synced"
        and is retried on the next cron run (step 5)
5. Retry: process any rows stuck at status="synced" older than 10 minutes
6. Update sync_state.last_synced_at
```

### Secrets (macOS Keychain)

All sensitive credentials are stored in macOS Keychain and retrieved at runtime — never written to disk or committed to git.

| Secret | Keychain service name |
|--------|-----------------------|
| Garmin password | `coachcarter-garmin` |
| Gmail App Password (nodemailer SMTP) | `coachcarter-gmail` |
| Supabase service key | `coachcarter-supabase` |
| Anthropic API key | `coachcarter-anthropic` |

Retrieve at runtime:
```bash
security find-generic-password -s "coachcarter-garmin" -w
```

### Environment Variables (non-sensitive)

```
SUPABASE_URL=
COACHCARTER_EMAIL=<placeholder>
```

---

## Step 2: Match & Analyze

### Skill: `/analyze-workout {id}`

Handles all sport types through the same pipeline. The amount of FIT data varies by sport; the email fills the gap.

```
1. LOAD
   - Fetch workout row from Supabase
   - Download .FIT from Supabase Storage
   - Parse FIT file using fit-file-parser
   - Update status = "analyzing"

2. EXTRACT METRICS (sport-dependent)
   All sports:   duration_min, calories, start_time, end_time
   Bike:         avg_power, normalized_power, variability_index, intensity_factor,
                 power_distribution (Z1–Z5), avg_hr, max_hr, hr_drift, tss,
                 efficiency (aerobic decoupling), intervals_detected
   Swim:         avg_pace_sec_per_100m (full session), main_set_pace_sec_per_100m
                 (estimated from fastest sustained blocks), total_distance_m, avg_hr
   Run:          avg_pace_sec_per_km, avg_hr, max_hr, hr_drift, tss, efficiency
   Strength:     duration_min, calories only — no further analysis

3. MATCH TO PLAN
   a. Calculate plan_week: ((floor((date - plan_start_date) / 7)) % 4) + 1
      Cycles: week 1 → 2 → 3 → 4 → 1 → 2 → ...
   b. Determine day_of_week from activity start_time
   c. Match by (plan_week, day_of_week, sport) against plan.json sessions
      Saturday bike → sat_bike | Saturday run → sat_run
      Sunday swim   → sun_swim | Sunday run  → sun_run
   d. No match → plan_session_id = "unplanned", compliance_score = null
      Email is still sent (see unplanned handling in step 5)

4. COMPLIANCE SCORE (matched sessions only)

   Compliance is computed by comparing actual FIT metrics against the targets
   defined in plan.json for the matched session. No benchmarks are hardcoded
   in the skills — all thresholds come from plan.json.

   Bike (intervals):
   - Whether detected work intervals match the prescribed number of sets
   - Whether main-set power fell within plan.json power_min / power_max
   - Whether VI stayed within plan.json vi_max
   - Whether duration fell within ±15% of plan.json duration_min

   Swim:
   - Whether main_set_pace_sec matched plan.json css_target_sec_per_100m
     (main-set pace used, not full-session average, so warmup/drills don't skew the score)
   - Whether total_distance_m reached plan.json total_distance_m

   Run:
   - Whether avg_pace_sec_per_km fell within plan.json pace_min_sec / pace_max_sec
   - Whether HR stayed under plan.json hr_max for the majority of the session
   - Whether duration fell within ±15% of plan.json duration_min

   Strength:
   - No FIT-based score (duration/calories don't indicate compliance)
   - Compliance determined entirely from email reply in /finalize-coaching

5. EMAIL (via nodemailer, sent from COACHCARTER_EMAIL)

   Subject: "[CoachCarter] {Day} {Sport} — feedback needed"
   Store SMTP message_id in workouts.email_message_id at send time.
   Update status = "awaiting_feedback"

   Bike example:
   "Monday bike done. 58min, NP 174W (target 171–181W ✓), VI 1.03 ✓,
    3/3 intervals ✓, TSS 78 (target 75).
    How did it feel? Scale 1–10, and what went well / didn't?"

   Strength A example:
   "Tuesday Strength A done — 52min, 180kcal.
    Prescribed: KB Swing 3×12, Single-leg RDL 3×8/side, Goblet 3×10,
    Suitcase Carry 3×20m/side, KB Row 3×10/side + 30min Hip Mobility.

    Quick check-in:
    1. What KB weight for Swing / RDL / Goblet / Row?
    2. All sets and reps done, or anything cut?
    3. Full 30min mobility or shorter?
    4. RPE 1–10, and anything that felt off?"

   Strength B example:
   "Thursday Strength B done — 48min, 165kcal.
    Prescribed: Turkish Get-Up 2×3/side, Bulgarian Split Squat 3×8/side,
    KB Clean 3×5/side, Dead Bug 3×8, Renegade Row 3×5/side + 30min T-spine Mobility.

    Quick check-in:
    1. What KB weight for TGU / Split Squat / Clean?
    2. All sets and reps done, or anything cut?
    3. Full 30min mobility or shorter?
    4. RPE 1–10, and anything that felt off?"

   Unplanned workout:
   "Unplanned {sport} detected — {duration}min, {distance}km.
    No prescription to match. How did it go and what was this session for?"
   compliance_score stays null; coaching report is informal feedback only.

6. ON EMAIL REPLY (IMAP polling of COACHCARTER_EMAIL inbox)
   - Poll dedicated CoachCarter inbox via IMAP on a short interval
   - Match reply to workout: workouts row where email_message_id = In-Reply-To header
   - Store reply in workouts.feedback, set feedback_received_at
   - Trigger /finalize-coaching {id}

   The dedicated inbox contains only CoachCarter emails — no filtering needed.

7. /finalize-coaching {id}
   - Claude pass 2: FIT metrics + email reply + prescribed session from plan.json
   - For strength: parse reply to extract exercises done, weights, sets/reps,
     mobility duration, RPE. Compute compliance:
       exercise completion + sets/reps completion + mobility completion
       (all thresholds from plan.json targets)
   - For all types: write 2–3 paragraph coaching report
   - If compliance < 70%: propose plan.json adjustment, ask for confirmation first
   - Update Supabase: status = "complete", compliance_score, coaching_report
```

---

## Supabase Schema

### `workouts` table

```sql
workouts (
  id                      uuid primary key default gen_random_uuid(),
  garmin_activity_id      bigint unique not null,

  -- Identity (raw sport values from Garmin: bike, swim, run, strength)
  sport                   text not null,
  date                    date not null,
  day_of_week             text,
  start_time              timestamptz,
  end_time                timestamptz,

  -- Plan matching
  plan_week               int,      -- 1–4, cycling
  plan_session_id         text,     -- mon_bike | tue_strength | wed_swim | thu_strength
                                    -- sat_bike | sat_run | sun_swim | sun_run
                                    -- unplanned | null

  -- Raw storage
  fit_file_path           text,

  -- Universal FIT fields
  duration_min            numeric,
  calories                int,

  -- Endurance-only FIT fields (null for strength)
  avg_hr                  int,
  max_hr                  int,
  hr_drift                int,
  tss                     int,
  avg_power               int,
  normalized_power        int,
  variability_index       numeric,
  intensity_factor        numeric,
  power_distribution      jsonb,    -- { z1, z2, z3, z4, z5 } as percentages
  avg_pace_sec            numeric,  -- per 100m (swim) or per km (run)
  main_set_pace_sec       numeric,  -- swim: CSS-portion pace only
  distance_km             numeric,
  efficiency              jsonb,    -- aerobic decoupling data
  intervals_detected      jsonb,    -- { work_intervals, avg_work_power, ... }

  -- Compliance
  compliance_score        int,      -- 0–100, null if unplanned or pre-email strength
  compliance_breakdown    jsonb,

  -- Email feedback loop
  email_message_id        text,     -- SMTP message_id, used to match IMAP replies
  feedback                text,     -- raw email reply
  feedback_received_at    timestamptz,

  -- Coaching
  coaching_report         text,

  -- Status flow: synced → analyzing → awaiting_feedback → complete
  status                  text default 'synced',

  created_at              timestamptz default now()
)
```

### `sync_state` table

```sql
sync_state (
  id              int primary key default 1,  -- enforces single row
  last_synced_at  timestamptz
)
```

### `weekly_summaries` table

```sql
weekly_summaries (
  id                  uuid primary key default gen_random_uuid(),
  plan_week           int,
  week_start_date     date,
  week_end_date       date,
  overall_compliance  int,    -- 0–100 average across completed sessions
  sessions_completed  int,
  sessions_missed     int,
  summary             text,   -- coaching narrative
  created_at          timestamptz default now()
)
```

---

## Weekly Review

### Skill: `/weekly-review`

Cron, Sunday 20:00. Outbound email only — no reply handling.

```
1. Calculate plan_week and date range (Mon–Sun)
2. Query Supabase: all workouts for the week
3. For each planned session in plan.json:
   - completed (status = complete) | missed (no row) | pending (still analyzing)
4. Compile: compliance per session, overall avg, missed sessions, week-on-week trend
5. Write 3–5 paragraph coaching summary:
   what went well, what was missed + impact, one plan.json adjustment if warranted,
   focus for next week
6. Send via nodemailer (from COACHCARTER_EMAIL), write to weekly_summaries table
```

---

## Skills Summary

| Skill | Trigger | What it does |
|-------|---------|--------------|
| `/sync-garmin` | Cron, every 4hr | Polls Garmin Connect, downloads FIT files, stores in Supabase, calls /analyze-workout |
| `/analyze-workout {id}` | Auto (or manual) | Parses FIT, matches plan, scores compliance, sends email |
| `/finalize-coaching {id}` | IMAP polling detects reply | Combines FIT + feedback, computes strength compliance, writes coaching report |
| `/weekly-review` | Cron, Sunday 20:00 | Week vs plan summary, sends email, writes to weekly_summaries |
| `/update-plan` | Manual | Updates plan.json from conversation |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Skills runtime | Claude Code |
| Garmin sync | `garmin-connect` npm (unofficial, stable 5+ years) |
| FIT parsing | `fit-file-parser` npm (from IronCoach v1) |
| Database | Supabase (Postgres) |
| File storage | Supabase Storage |
| Email sending | nodemailer via Gmail SMTP (App Password in macOS Keychain) |
| Email receiving | IMAP polling of dedicated CoachCarter inbox |
| Secrets | macOS Keychain (`security` CLI) |
| Cron | Claude Code cron system |
| Plan file | `coachCarter/plan.json` (version controlled) |

---

## Out of Scope (Steps 1 + 2)

- Web dashboard (Step 3 — static HTML on nayankote.com)
- Authentication (personal tool, single user)
- Strava integration (Garmin Connect direct for full FIT data)
- Historical backfill of pre-March-17 workouts

---

## Directory Structure

```
coachCarter/
  plan.json                              # Training plan (source of truth)
  offseason_training_plan.xlsx           # Original Excel (reference only)
  supabase-setup.sql                     # Schema creation script
  skills/
    sync-garmin.md
    analyze-workout.md
    finalize-coaching.md
    weekly-review.md
    update-plan.md
  docs/
    superpowers/
      specs/
        2026-03-19-coachcarter-design.md   # This file
```
