# Frontend Calendar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Training Peaks-style weekly calendar at `nayankote.github.io/coachCarter` showing planned workouts from `plan.json` and completed workouts from Supabase, with clickable workout detail panels.

**Architecture:** A pure static site in `docs/` served by GitHub Pages. A GitHub Actions workflow runs on every push and every 30 minutes to fetch workout data from Supabase (using the service key as a secret) and write `docs/workouts.json` — the browser never touches the API directly. The HTML reads two local JSON files (`plan.json`, `workouts.json`) and renders everything client-side with vanilla JS.

**Tech Stack:** Plain HTML, CSS, vanilla JavaScript. No build step, no framework, no npm. GitHub Pages from `docs/` folder on `main` branch.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/index.html` | Calendar page — all HTML, CSS, and JS in one file |
| `docs/workouts.json` | Pre-built by GitHub Actions from Supabase — never hand-edited |
| `docs/plan.json` | Copied from root `plan.json` by GitHub Actions |
| `scripts/build-frontend-data.js` | Node script: fetches Supabase workouts, cleans feedback field, writes JSON files |
| `.github/workflows/build-frontend.yml` | Runs build script on push + schedule, commits changed JSON files |

**Why one HTML file:** No build step means no bundler, no dependencies to manage. One file is trivially deployable and easy to maintain.

---

## Chunk 1: Data Pipeline

### Task 1: Build script + GitHub Actions workflow

**Files:**
- Create: `scripts/build-frontend-data.js`
- Create: `.github/workflows/build-frontend.yml`
- Create: `docs/` directory (empty initially, just the folder)

**Context:**
- Supabase client: `require('../lib/supabase').getSupabase()` — already set up
- `plan.json` is at the repo root
- GitHub secrets already set: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `feedback` field on old workouts contains raw MIME email (starts with `Delivered-To:`) — strip to just the plain text reply body for display
- `docs/workouts.json` and `docs/plan.json` are committed to the repo (GitHub Pages serves static files)

- [ ] **Step 1: Create the build script**

```js
// scripts/build-frontend-data.js
// Fetches workout data from Supabase and writes static JSON for the frontend.
// Run by GitHub Actions — never call directly with real secrets in browser.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../lib/supabase');

function extractFeedbackText(raw) {
  if (!raw) return null;
  // Old Gmail workouts: raw MIME email. Extract plain text body.
  if (raw.startsWith('Delivered-To:') || raw.startsWith('Received:')) {
    // Find blank line after headers, then take text up to next MIME boundary
    const bodyStart = raw.indexOf('\r\n\r\n');
    if (bodyStart === -1) return raw;
    const body = raw.slice(bodyStart + 4);
    // Strip MIME boundary lines (--000...) and quoted reply (lines starting with >)
    return body
      .split('\n')
      .filter(l => !l.startsWith('--') && !l.startsWith('>') && !l.startsWith('On '))
      .join('\n')
      .trim()
      .slice(0, 800); // cap length for display
  }
  // AgentMail workouts: already plain text
  return raw;
}

async function run() {
  const db = getSupabase();
  const { data: workouts, error } = await db
    .from('workouts')
    .select('id,garmin_activity_id,sport,date,day_of_week,plan_week,plan_session_id,duration_min,calories,avg_hr,tss,normalized_power,variability_index,intensity_factor,avg_pace_sec,distance_km,compliance_score,compliance_breakdown,coaching_report,feedback,status,start_time')
    .order('date', { ascending: true });

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

  // Clean feedback field before writing to public JSON
  const cleaned = workouts.map(w => ({
    ...w,
    feedback: extractFeedbackText(w.feedback),
  }));

  const docsDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  fs.writeFileSync(
    path.join(docsDir, 'workouts.json'),
    JSON.stringify(cleaned, null, 2)
  );

  // Copy plan.json to docs/
  const plan = fs.readFileSync(path.join(__dirname, '..', 'plan.json'), 'utf8');
  fs.writeFileSync(path.join(docsDir, 'plan.json'), plan);

  console.log(`[build-frontend] wrote ${cleaned.length} workouts to docs/workouts.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run locally to verify it works**

```bash
node scripts/build-frontend-data.js
```

Expected output:
```
[build-frontend] wrote N workouts to docs/workouts.json
```

Verify files exist:
```bash
ls docs/
# workouts.json  plan.json
```

- [ ] **Step 3: Create the GitHub Actions workflow**

```yaml
# .github/workflows/build-frontend.yml
name: Build Frontend Data

on:
  push:
    branches: [main]
  schedule:
    - cron: '*/30 * * * *'   # every 30 minutes
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - run: node scripts/build-frontend-data.js
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}

      - name: Commit updated JSON if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add docs/workouts.json docs/plan.json
          git diff --staged --quiet || git commit -m "chore: rebuild frontend data [skip ci]"
          git push
```

Note: `[skip ci]` in the commit message prevents an infinite loop (the commit would otherwise trigger the workflow again).

- [ ] **Step 4: Create docs/.gitkeep so the docs/ folder is tracked before the first build**

```bash
touch docs/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add scripts/build-frontend-data.js .github/workflows/build-frontend.yml docs/
git commit -m "feat: add frontend data build script and GitHub Actions workflow"
```

---

## Chunk 2: Calendar HTML

### Task 2: HTML + CSS skeleton

**Files:**
- Create: `docs/index.html`

**Context — Training Peaks layout:**
- Dark background (`#1a1a2e`), card-based layout
- Header: app name left, week range center, prev/next arrows + Today button right
- Weekly load strip below header: 7 sport pills showing planned vs actual TSS/minutes
- 7-column grid (Mon–Sun), each column: date header + workout cards stacked vertically
- Today's column has a subtle highlight border
- Workout cards: sport icon emoji + key stat + status color
  - Planned-only (no actual): dashed gray border, white text
  - Complete, compliance ≥ 80: green (`#22c55e` bg, dark text)
  - Complete, compliance 60–79: amber (`#f59e0b` bg, dark text)
  - Complete, compliance < 60: red (`#ef4444` bg, white text)
  - `awaiting_feedback`: orange with pulse animation (`#f97316`)
  - Unplanned actual workout: solid gray (`#6b7280`)
- Detail panel: slides in from the right, 380px wide, overlays calendar
- Mobile: single-column scroll (one day at a time), swipe not required

Sport icons:
- `bike` → 🚴
- `run` → 🏃
- `swim` → 🏊
- `strength` → 💪

- [ ] **Step 1: Write `docs/index.html` (HTML + CSS only, no JS yet)**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CoachCarter</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0f0f1a;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      background: #1a1a2e;
      border-bottom: 1px solid #2d2d4e;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .header-title { font-size: 18px; font-weight: 700; color: #a78bfa; letter-spacing: -0.3px; }
    .header-week { font-size: 15px; font-weight: 600; color: #e2e8f0; }
    .header-nav { display: flex; gap: 8px; align-items: center; }
    .nav-btn {
      background: #2d2d4e; border: none; color: #e2e8f0;
      padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
      transition: background 0.15s;
    }
    .nav-btn:hover { background: #3d3d5e; }
    .nav-btn.today { color: #a78bfa; border: 1px solid #a78bfa; background: transparent; }
    .nav-btn.today:hover { background: #a78bfa22; }

    /* ── Weekly summary strip ── */
    .week-summary {
      display: flex;
      gap: 12px;
      padding: 10px 20px;
      background: #1a1a2e;
      border-bottom: 1px solid #2d2d4e;
      overflow-x: auto;
    }
    .summary-pill {
      display: flex; align-items: center; gap: 6px;
      background: #252540; border-radius: 20px;
      padding: 4px 12px; white-space: nowrap; font-size: 12px;
    }
    .summary-pill .icon { font-size: 14px; }
    .summary-pill .label { color: #94a3b8; }
    .summary-pill .value { font-weight: 600; color: #e2e8f0; }
    .summary-pill .planned { color: #64748b; margin-left: 2px; }

    /* ── Calendar grid ── */
    .calendar {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 1px;
      background: #2d2d4e;
      margin: 0;
      min-height: calc(100vh - 120px);
    }

    .day-col {
      background: #0f0f1a;
      display: flex;
      flex-direction: column;
    }
    .day-col.today { background: #13132a; }
    .day-col.today .day-header { border-bottom-color: #a78bfa; }

    .day-header {
      padding: 10px 8px 8px;
      border-bottom: 2px solid #2d2d4e;
      text-align: center;
    }
    .day-name { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; color: #64748b; }
    .day-date { font-size: 20px; font-weight: 700; color: #e2e8f0; line-height: 1.2; }
    .day-date.today-date {
      background: #a78bfa;
      color: #0f0f1a;
      border-radius: 50%;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      margin: 2px auto 0;
    }

    .day-sessions { padding: 8px 6px; display: flex; flex-direction: column; gap: 6px; flex: 1; }

    /* ── Workout cards ── */
    .workout-card {
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.1s;
      position: relative;
      overflow: hidden;
    }
    .workout-card:hover { transform: translateY(-1px); opacity: 0.92; }
    .workout-card:active { transform: translateY(0); }

    /* Status colours */
    .card-planned {
      background: transparent;
      border: 1.5px dashed #3d3d5e;
      color: #94a3b8;
    }
    .card-complete-good  { background: #14532d; border: 1px solid #22c55e; color: #bbf7d0; }
    .card-complete-ok    { background: #451a03; border: 1px solid #f59e0b; color: #fde68a; }
    .card-complete-poor  { background: #450a0a; border: 1px solid #ef4444; color: #fecaca; }
    .card-awaiting       { background: #431407; border: 1px solid #f97316; color: #fed7aa; }
    .card-unplanned      { background: #1e293b; border: 1px solid #475569; color: #94a3b8; }

    @keyframes pulse-border {
      0%, 100% { border-color: #f97316; }
      50% { border-color: #fb923c88; }
    }
    .card-awaiting { animation: pulse-border 2s infinite; }

    .card-sport { font-size: 16px; line-height: 1; }
    .card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .card-stat  { font-size: 12px; margin-top: 3px; }
    .card-score {
      position: absolute; top: 6px; right: 8px;
      font-size: 11px; font-weight: 700; opacity: 0.9;
    }

    /* ── Detail panel ── */
    .panel-overlay {
      position: fixed; inset: 0;
      background: #00000066;
      z-index: 20;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .panel-overlay.open { opacity: 1; pointer-events: all; }

    .detail-panel {
      position: fixed; top: 0; right: -400px; bottom: 0;
      width: 380px; max-width: 100vw;
      background: #1a1a2e;
      border-left: 1px solid #2d2d4e;
      z-index: 21;
      overflow-y: auto;
      transition: right 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      padding: 0;
    }
    .detail-panel.open { right: 0; }

    .panel-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 20px 20px 16px;
      border-bottom: 1px solid #2d2d4e;
      position: sticky; top: 0; background: #1a1a2e; z-index: 1;
    }
    .panel-sport-icon { font-size: 28px; margin-right: 12px; }
    .panel-title-block { flex: 1; }
    .panel-title { font-size: 16px; font-weight: 700; color: #e2e8f0; }
    .panel-subtitle { font-size: 12px; color: #64748b; margin-top: 2px; }
    .panel-close {
      background: none; border: none; color: #64748b; font-size: 20px;
      cursor: pointer; padding: 0 0 0 12px; line-height: 1;
    }
    .panel-close:hover { color: #e2e8f0; }

    .panel-body { padding: 16px 20px; }

    .panel-section { margin-bottom: 20px; }
    .panel-section-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
      color: #64748b; font-weight: 600; margin-bottom: 10px;
    }

    .metrics-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .metric-box {
      background: #252540; border-radius: 8px; padding: 10px 12px;
    }
    .metric-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .metric-value { font-size: 18px; font-weight: 700; color: #e2e8f0; margin-top: 2px; }
    .metric-unit { font-size: 11px; color: #94a3b8; font-weight: 400; }

    .compliance-bar-wrap { background: #252540; border-radius: 8px; padding: 12px; }
    .compliance-score-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .compliance-score-num { font-size: 28px; font-weight: 800; }
    .compliance-score-num.good  { color: #22c55e; }
    .compliance-score-num.ok    { color: #f59e0b; }
    .compliance-score-num.poor  { color: #ef4444; }
    .compliance-label { font-size: 11px; color: #64748b; }
    .compliance-bar-bg { background: #1a1a2e; border-radius: 4px; height: 6px; overflow: hidden; }
    .compliance-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s; }
    .compliance-bar-fill.good { background: #22c55e; }
    .compliance-bar-fill.ok   { background: #f59e0b; }
    .compliance-bar-fill.poor { background: #ef4444; }

    .coaching-report {
      background: #252540; border-radius: 8px; padding: 14px;
      line-height: 1.6; color: #cbd5e1; font-size: 13px;
      white-space: pre-wrap;
    }
    .coaching-report-empty { color: #475569; font-style: italic; font-size: 13px; }

    .feedback-box {
      background: #252540; border-radius: 8px; padding: 14px;
      font-size: 13px; color: #94a3b8; line-height: 1.5;
      white-space: pre-wrap;
    }

    .status-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
    }
    .badge-complete  { background: #14532d; color: #22c55e; }
    .badge-awaiting  { background: #431407; color: #f97316; }
    .badge-planned   { background: #1e293b; color: #64748b; }
    .badge-unplanned { background: #1e293b; color: #94a3b8; }

    /* ── Responsive ── */
    @media (max-width: 700px) {
      .calendar { grid-template-columns: 1fr; }
      .day-col:not(.today) { display: none; }
      .detail-panel { width: 100vw; }
      .week-summary { gap: 8px; }
    }
  </style>
</head>
<body>

  <header class="header">
    <div class="header-title">CoachCarter</div>
    <div class="header-week" id="weekLabel">—</div>
    <div class="header-nav">
      <button class="nav-btn" id="prevWeek">&#8592;</button>
      <button class="nav-btn today" id="todayBtn">Today</button>
      <button class="nav-btn" id="nextWeek">&#8594;</button>
    </div>
  </header>

  <div class="week-summary" id="weekSummary"></div>

  <div class="calendar" id="calendar"></div>

  <div class="panel-overlay" id="overlay"></div>
  <aside class="detail-panel" id="detailPanel">
    <div class="panel-header">
      <div style="display:flex;align-items:center">
        <span class="panel-sport-icon" id="panelIcon"></span>
        <div class="panel-title-block">
          <div class="panel-title" id="panelTitle"></div>
          <div class="panel-subtitle" id="panelSubtitle"></div>
        </div>
      </div>
      <button class="panel-close" id="panelClose">&#x2715;</button>
    </div>
    <div class="panel-body" id="panelBody"></div>
  </aside>

  <script>
  // JS will be added in Task 3+
  </script>
</body>
</html>
```

- [ ] **Step 2: Open in browser to verify layout renders correctly**

```bash
open docs/index.html
```

Expected: dark page, header visible, empty calendar area, no JS errors in console.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "feat: add calendar HTML/CSS skeleton"
```

---

## Chunk 3: Calendar Logic

### Task 3: JS data loading + week navigation

**Files:**
- Modify: `docs/index.html` (replace the `<script>` block)

**Context:**
- `plan.json` structure: `{ plan_start_date: "YYYY-MM-DD", weeks: [{ week: N, sessions: [{ id, day, sport, type, duration_min, targets, coaching_notes }] }] }`
- `workouts.json`: array of workout rows from Supabase (see schema above)
- Week navigation: current ISO week by default. `prevWeek`/`nextWeek` shift by 7 days. `Today` resets.
- Each "week" in the calendar is Mon–Sun. Compute Monday of the current displayed week.
- Map plan sessions to calendar dates: `plan_start_date` + `(week - 1) * 7` + offset by day name
- Map actual workouts by `date` field (YYYY-MM-DD string)

Day-name → offset from Monday:
```
Monday=0, Tuesday=1, Wednesday=2, Thursday=3, Friday=4, Saturday=5, Sunday=6
```

- [ ] **Step 1: Add data loading + week navigation JS**

Replace the `<script>` block in `docs/index.html` with:

```html
<script>
const SPORT_ICON = { bike: '🚴', run: '🏃', swim: '🏊', strength: '💪' };
const DAY_OFFSET = { monday:0, tuesday:1, wednesday:2, thursday:3, friday:4, saturday:5, sunday:6 };
const DAY_NAMES  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

let plan = null;
let workouts = [];
let currentMonday = getMonday(new Date());

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0,0,0,0);
  return dt;
}

function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

function toYMD(d) {
  // Use local date parts — toISOString() returns UTC which is wrong for IST (+5:30) and other positive-offset zones
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${monday.toLocaleDateString('en-US', opts)} – ${sunday.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`;
}

// ── Plan → date mapping ───────────────────────────────────────────────────────

function buildPlanMap(plan) {
  // Returns { "YYYY-MM-DD": [session, ...] }
  const map = {};
  const start = new Date(plan.plan_start_date + 'T00:00:00');
  // plan_start_date is always a Monday
  for (const week of plan.weeks) {
    const weekStart = addDays(start, (week.week - 1) * 7);
    for (const session of week.sessions) {
      const offset = DAY_OFFSET[session.day.toLowerCase()] ?? 0;
      const date = toYMD(addDays(weekStart, offset));
      if (!map[date]) map[date] = [];
      map[date].push({ ...session, _week: week.week, _weekLabel: week.label });
    }
  }
  return map;
}

// ── Workout → date mapping ────────────────────────────────────────────────────

function buildWorkoutMap(workouts) {
  // Returns { "YYYY-MM-DD": [workout, ...] }
  const map = {};
  for (const w of workouts) {
    if (!map[w.date]) map[w.date] = [];
    map[w.date].push(w);
  }
  return map;
}

// ── Card helpers ──────────────────────────────────────────────────────────────

function cardClass(workout) {
  if (!workout) return 'card-planned';
  if (workout.status === 'awaiting_feedback' || workout.status === 'processing') return 'card-awaiting';
  if (workout.status === 'complete') {
    const s = workout.compliance_score;
    if (s == null) return 'card-complete-good';
    if (s >= 80) return 'card-complete-good';
    if (s >= 60) return 'card-complete-ok';
    return 'card-complete-poor';
  }
  return 'card-unplanned';
}

function cardStat(workout, session) {
  if (!workout) {
    // Planned only
    const s = session;
    if (s.sport === 'bike') return `${s.duration_min}min · ${s.targets?.tss_target ?? '—'}TSS`;
    if (s.sport === 'run')  return `${s.duration_min}min`;
    if (s.sport === 'swim') return `${s.targets?.total_distance_m ?? '—'}m`;
    if (s.sport === 'strength') return `${s.duration_min}min · ${s.type}`;
    return `${s.duration_min}min`;
  }
  const w = workout;
  if (w.sport === 'bike') return `${w.duration_min?.toFixed(0) ?? '—'}min${w.normalized_power ? ' · ' + w.normalized_power + 'W' : ''}${w.tss ? ' · ' + Math.round(w.tss) + 'TSS' : ''}`;
  if (w.sport === 'run')  return `${w.duration_min?.toFixed(0) ?? '—'}min${w.avg_pace_sec ? ' · ' + formatPace(w.avg_pace_sec) : ''}`;
  if (w.sport === 'swim') return `${w.duration_min?.toFixed(0) ?? '—'}min${w.distance_km ? ' · ' + (w.distance_km * 1000).toFixed(0) + 'm' : ''}`;
  if (w.sport === 'strength') return `${w.duration_min?.toFixed(0) ?? '—'}min${w.calories ? ' · ' + w.calories + 'kcal' : ''}`;
  return `${w.duration_min?.toFixed(0) ?? '—'}min`;
}

function formatPace(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2,'0')}/km`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  if (!plan) return;
  const planMap    = buildPlanMap(plan);
  const workoutMap = buildWorkoutMap(workouts);
  const today      = toYMD(new Date());

  // Header week label
  document.getElementById('weekLabel').textContent = formatWeekLabel(currentMonday);

  // Calendar columns
  const cal = document.getElementById('calendar');
  cal.innerHTML = '';

  // Week summary accumulators
  const summaryData = { bike: {planned:0,actual:0}, run: {planned:0,actual:0}, swim: {planned:0,actual:0}, strength: {planned:0,actual:0} };

  for (let i = 0; i < 7; i++) {
    const date   = addDays(currentMonday, i);
    const ymd    = toYMD(date);
    const isToday = ymd === today;
    const sessions = planMap[ymd] || [];
    const dayWorkouts = workoutMap[ymd] || [];

    // Accumulate summary
    for (const s of sessions)   { if (summaryData[s.sport]) summaryData[s.sport].planned += s.duration_min || 0; }
    for (const w of dayWorkouts) { if (summaryData[w.sport]) summaryData[w.sport].actual  += w.duration_min || 0; }

    const col = document.createElement('div');
    col.className = 'day-col' + (isToday ? ' today' : '');

    const dayNum = date.getDate();
    const dateEl = isToday
      ? `<div class="day-date today-date">${dayNum}</div>`
      : `<div class="day-date">${dayNum}</div>`;

    col.innerHTML = `
      <div class="day-header">
        <div class="day-name">${DAY_NAMES[i].slice(0,3)}</div>
        ${dateEl}
      </div>
      <div class="day-sessions" id="day-${ymd}"></div>
    `;
    cal.appendChild(col);

    const sessionsEl = col.querySelector('.day-sessions');

    // Render planned + matched actual pairs
    const matchedWorkoutIds = new Set();
    for (const session of sessions) {
      const matched = dayWorkouts.find(w => w.plan_session_id === session.id && !matchedWorkoutIds.has(w.id));
      if (matched) matchedWorkoutIds.add(matched.id);
      renderCard(sessionsEl, session, matched || null);
    }

    // Render unmatched actual workouts (no plan session)
    for (const w of dayWorkouts) {
      if (!matchedWorkoutIds.has(w.id)) {
        renderCard(sessionsEl, null, w);
      }
    }
  }

  renderWeekSummary(summaryData);
}

function renderCard(container, session, workout) {
  const sport  = workout?.sport ?? session?.sport ?? 'bike';
  const icon   = SPORT_ICON[sport] ?? '🏋️';
  const cls    = cardClass(workout);
  const stat   = cardStat(workout, session ?? { sport, duration_min: workout?.duration_min, targets: {} });
  const score  = workout?.compliance_score;
  const label  = session ? `${session.type ?? session.sport}` : (workout?.sport ?? '');

  const card = document.createElement('div');
  card.className = `workout-card ${cls}`;
  card.innerHTML = `
    <div class="card-sport">${icon}</div>
    <div class="card-title">${label}</div>
    <div class="card-stat">${stat}</div>
    ${score != null ? `<div class="card-score">${score}</div>` : ''}
  `;
  card.addEventListener('click', () => openPanel(session, workout));
  container.appendChild(card);
}

function renderWeekSummary(data) {
  const el = document.getElementById('weekSummary');
  el.innerHTML = '';
  const sports = Object.entries(data).filter(([,v]) => v.planned > 0 || v.actual > 0);
  if (!sports.length) {
    el.innerHTML = '<div style="color:#475569;font-size:12px;padding:2px 0">No sessions this week</div>';
    return;
  }
  for (const [sport, { planned, actual }] of sports) {
    const pill = document.createElement('div');
    pill.className = 'summary-pill';
    pill.innerHTML = `
      <span class="icon">${SPORT_ICON[sport]}</span>
      <span class="label">${sport}</span>
      <span class="value">${Math.round(actual)}min</span>
      <span class="planned">/ ${Math.round(planned)}min planned</span>
    `;
    el.appendChild(pill);
  }
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function openPanel(session, workout) {
  const sport = workout?.sport ?? session?.sport ?? 'bike';
  const date  = workout?.date ?? '—';
  const icon  = SPORT_ICON[sport] ?? '🏋️';

  document.getElementById('panelIcon').textContent = icon;
  document.getElementById('panelTitle').textContent =
    `${sport.charAt(0).toUpperCase() + sport.slice(1)}${session ? ' — ' + (session.type ?? '') : ''}`;
  document.getElementById('panelSubtitle').textContent = date;

  const body = document.getElementById('panelBody');
  body.innerHTML = buildPanelBody(session, workout);

  document.getElementById('detailPanel').classList.add('open');
  document.getElementById('overlay').classList.add('open');
}

function closePanel() {
  document.getElementById('detailPanel').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

function buildPanelBody(session, workout) {
  const parts = [];

  // Status badge
  if (workout) {
    const badgeClass = workout.status === 'complete' ? 'badge-complete'
                     : (workout.status === 'awaiting_feedback' || workout.status === 'processing') ? 'badge-awaiting'
                     : 'badge-unplanned';
    const badgeText  = workout.status === 'awaiting_feedback' ? 'Awaiting feedback'
                     : workout.status === 'processing' ? 'Processing'
                     : workout.status === 'complete' ? 'Complete'
                     : workout.status ?? 'Synced';
    parts.push(`<div style="margin-bottom:16px"><span class="status-badge ${badgeClass}">${badgeText}</span></div>`);
  }

  // Metrics
  const metrics = buildMetrics(workout, session);
  if (metrics.length) {
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Metrics</div>
        <div class="metrics-grid">${metrics.map(([l,v,u]) => `
          <div class="metric-box">
            <div class="metric-label">${l}</div>
            <div class="metric-value">${v}<span class="metric-unit"> ${u||''}</span></div>
          </div>`).join('')}
        </div>
      </div>`);
  }

  // Compliance
  if (workout?.compliance_score != null) {
    const s = workout.compliance_score;
    const cls = s >= 80 ? 'good' : s >= 60 ? 'ok' : 'poor';
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Compliance</div>
        <div class="compliance-bar-wrap">
          <div class="compliance-score-row">
            <span class="compliance-score-num ${cls}">${s}</span>
            <span class="compliance-label">/ 100</span>
          </div>
          <div class="compliance-bar-bg">
            <div class="compliance-bar-fill ${cls}" style="width:${s}%"></div>
          </div>
        </div>
      </div>`);
  }

  // Coaching notes (planned only)
  if (!workout && session?.coaching_notes) {
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Coach notes</div>
        <div class="coaching-report">${esc(session.coaching_notes)}</div>
      </div>`);
  }

  // Coaching report (completed)
  if (workout?.coaching_report) {
    // esc() first to prevent XSS, then apply bold markdown transform on the escaped string
    const report = esc(workout.coaching_report)
      .replace(/^#+ .+&lt;br&gt;/gm, '')   // strip escaped markdown headers
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .trim();
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Coaching report</div>
        <div class="coaching-report">${report}</div>
      </div>`);
  } else if (workout && workout.status !== 'awaiting_feedback') {
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Coaching report</div>
        <div class="coaching-report-empty">No coaching report yet.</div>
      </div>`);
  }

  // Athlete feedback
  if (workout?.feedback) {
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Your feedback</div>
        <div class="feedback-box">${esc(workout.feedback)}</div>
      </div>`);
  }

  // Session targets (planned, collapsed)
  if (session?.targets) {
    parts.push(`
      <div class="panel-section">
        <div class="panel-section-title">Session plan</div>
        <div class="coaching-report">${esc(formatTargets(session))}</div>
      </div>`);
  }

  return parts.join('');
}

function buildMetrics(workout, session) {
  if (!workout) {
    // Show planned targets as metrics
    const s = session;
    const m = [];
    if (s?.duration_min)  m.push(['Duration', s.duration_min, 'min']);
    if (s?.targets?.tss_target) m.push(['Target TSS', s.targets.tss_target, '']);
    return m;
  }
  const w = workout;
  const m = [];
  if (w.duration_min)     m.push(['Duration',   w.duration_min.toFixed(0),  'min']);
  if (w.calories)         m.push(['Calories',   w.calories,                  'kcal']);
  if (w.sport === 'bike') {
    if (w.normalized_power)   m.push(['NP',   w.normalized_power, 'W']);
    if (w.tss)                m.push(['TSS',  Math.round(w.tss),   '']);
    if (w.variability_index)  m.push(['VI',   w.variability_index, '']);
    if (w.intensity_factor)   m.push(['IF',   w.intensity_factor,  '']);
  }
  if (w.sport === 'run') {
    if (w.avg_pace_sec)  m.push(['Avg pace', formatPace(w.avg_pace_sec), '']);
    if (w.avg_hr)        m.push(['Avg HR',   w.avg_hr, 'bpm']);
  }
  if (w.sport === 'swim') {
    if (w.distance_km)         m.push(['Distance', (w.distance_km*1000).toFixed(0), 'm']);
    if (w.avg_pace_sec)        m.push(['Pace', formatPace(w.avg_pace_sec), '/100m']);
  }
  if (w.avg_hr && w.sport !== 'run') m.push(['Avg HR', w.avg_hr, 'bpm']);
  return m;
}

function formatTargets(session) {
  const t = session.targets ?? {};
  const lines = [];
  if (session.sport === 'bike') {
    if (t.warmup)    lines.push(`Warmup: ${t.warmup}`);
    if (t.main_set)  lines.push(`Main: ${t.main_set}`);
    if (t.cooldown)  lines.push(`Cooldown: ${t.cooldown}`);
  }
  if (session.sport === 'swim') {
    if (t.main_set?.description) lines.push(t.main_set.description);
  }
  if (session.sport === 'strength') {
    (t.exercises || []).forEach(e => {
      lines.push(`${e.name}: ${e.sets}×${e.reps || e.distance_m + 'm'}${e.per_side ? '/side' : ''}`);
    });
    if (t.mobility_min) lines.push(`Mobility: ${t.mobility_min}min ${t.mobility_focus || ''}`);
  }
  if (session.coaching_notes) lines.push('', `Notes: ${session.coaching_notes}`);
  return lines.join('\n');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br>');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.getElementById('prevWeek').addEventListener('click',  () => { currentMonday = addDays(currentMonday, -7); render(); });
document.getElementById('nextWeek').addEventListener('click',  () => { currentMonday = addDays(currentMonday,  7); render(); });
document.getElementById('todayBtn').addEventListener('click',  () => { currentMonday = getMonday(new Date()); render(); });
document.getElementById('panelClose').addEventListener('click', closePanel);
document.getElementById('overlay').addEventListener('click',   closePanel);

async function init() {
  // Single regex handles all cases: trailing slash, index.html, and deep paths
  const base = document.location.pathname.replace(/\/[^/]*$/, '');
  const [planRes, workoutsRes] = await Promise.all([
    fetch(base + '/plan.json'),
    fetch(base + '/workouts.json'),
  ]);
  plan     = await planRes.json();
  workouts = await workoutsRes.json();
  render();
}

init().catch(err => {
  document.getElementById('calendar').innerHTML =
    `<div style="padding:40px;color:#ef4444">Failed to load data: ${err.message}</div>`;
});
</script>
```

- [ ] **Step 2: Run build script to generate JSON files**

```bash
node scripts/build-frontend-data.js
```

- [ ] **Step 3: Open in browser and verify**

```bash
open docs/index.html
```

Expected:
- Header shows current week date range
- Calendar shows 7 day columns
- Week summary strip shows sport breakdowns
- Workout cards appear on correct dates with correct colors
- Click a card → detail panel slides in from right
- Click ✕ or overlay → panel closes

- [ ] **Step 4: Navigate weeks**

Click ← → and Today and verify dates shift correctly, cards appear on right days.

- [ ] **Step 5: Commit**

```bash
git add docs/index.html docs/workouts.json docs/plan.json
git commit -m "feat: add calendar JS — data loading, week nav, cards, detail panel"
```

---

## Chunk 4: GitHub Pages Deployment

### Task 4: Enable GitHub Pages + verify deployment

**Files:**
- No code changes — GitHub UI configuration

**Context:**
- Repo: `https://github.com/nayankote/coachCarter`
- Pages will serve from `docs/` folder on `main` branch
- URL after enabling: `https://nayankote.github.io/coachCarter`
- The `build-frontend.yml` workflow commits `docs/workouts.json` + `docs/plan.json` to `main`, which triggers a Pages rebuild automatically (GitHub Pages rebuilds on every push to the source branch)
- The JS `fetch` uses a relative base path so it works both locally (file://) and on Pages

- [ ] **Step 1: Enable GitHub Pages**

1. Go to `https://github.com/nayankote/coachCarter/settings/pages`
2. Source: **Deploy from a branch**
3. Branch: **main**, Folder: **/docs**
4. Click Save

- [ ] **Step 2: Push all committed changes to trigger first deploy**

```bash
git push origin main
```

- [ ] **Step 3: Wait ~60 seconds, then verify**

Visit `https://nayankote.github.io/coachCarter` — should show the calendar.

- [ ] **Step 4: Verify the build workflow ran**

Go to `https://github.com/nayankote/coachCarter/actions` and confirm `Build Frontend Data` succeeded.

- [ ] **Step 5: Verify data freshness**

Check that `docs/workouts.json` in the repo reflects real Supabase data (not test data).

---

## Notes for implementer

**Do not touch any files outside `docs/`, `scripts/build-frontend-data.js`, and `.github/workflows/build-frontend.yml`.** The backend (lib/, scripts/sync-garmin.js, scripts/analyze-workout.js, supabase/, etc.) is complete and live — do not modify it.

**The `feedback` field** on old workouts contains raw MIME email headers — the build script strips these before writing to `docs/workouts.json`. New workouts (via AgentMail) will have clean plain text.

**No tests** for this frontend — it's pure presentation with no logic worth unit-testing. Verification is visual (open in browser) and functional (cards appear, panel opens, navigation works).

**Base URL handling:** `fetch(base + '/plan.json')` uses the pathname to compute a relative base, so it works at `file:///path/docs/index.html` locally and at `https://nayankote.github.io/coachCarter/` on Pages without any config change.
