# CoachCarter Sync & Analyze — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CoachCarter pipeline: sync Garmin workouts, parse FIT files, match against plan.json, score compliance, send email feedback requests, receive replies via IMAP, and generate Claude-powered coaching reports.

**Architecture:** Node.js scripts are the execution layer; Claude Code skills are the intelligence layer that invokes them. All secrets live in macOS Keychain. Supabase stores workout data and FIT files. Email flows through a dedicated CoachCarter Gmail inbox using nodemailer (SMTP send) and imapflow (IMAP poll).

**Tech Stack:** Node.js 20+, Jest 29, @supabase/supabase-js 2, garmin-connect, fit-file-parser, nodemailer, imapflow, @anthropic-ai/sdk

---

## File Structure

**Create:**
- `coachCarter/package.json` — dependencies + scripts
- `coachCarter/jest.config.js` — Jest configuration
- `coachCarter/.env.example` — documented non-sensitive env template
- `coachCarter/.gitignore`
- `coachCarter/supabase-setup.sql` — schema creation
- `coachCarter/plan.json` — training plan stub (populated by user from Excel)
- `coachCarter/lib/keychain.js` — macOS Keychain retrieval via `security` CLI
- `coachCarter/lib/supabase.js` — Supabase client factory (service key from Keychain)
- `coachCarter/lib/garmin.js` — Garmin Connect: auth, fetch activities, download FIT, bike dedup
- `coachCarter/lib/fit-parser.js` — FIT buffer → sport-specific metrics object
- `coachCarter/lib/plan.js` — plan.json loader, plan_week calc, session matcher
- `coachCarter/lib/compliance.js` — compliance scoring: actual vs plan.json targets
- `coachCarter/lib/email.js` — nodemailer SMTP send + imapflow IMAP poll
- `coachCarter/lib/email-templates.js` — build feedback email body per sport
- `coachCarter/lib/coaching.js` — Claude API: generate coaching reports and strength compliance
- `coachCarter/scripts/sync-garmin.js` — `/sync-garmin` entry point
- `coachCarter/scripts/analyze-workout.js` — `/analyze-workout` entry point
- `coachCarter/scripts/finalize-coaching.js` — `/finalize-coaching` entry point
- `coachCarter/scripts/weekly-review.js` — `/weekly-review` entry point
- `coachCarter/scripts/update-plan.js` — `/update-plan` validator entry point
- `coachCarter/skills/sync-garmin.md`
- `coachCarter/skills/analyze-workout.md`
- `coachCarter/skills/finalize-coaching.md`
- `coachCarter/skills/weekly-review.md`
- `coachCarter/skills/update-plan.md`
- `coachCarter/tests/lib/*.test.js` — unit tests per lib module
- `coachCarter/tests/scripts/*.test.js` — integration tests per script
- `coachCarter/tests/fixtures/plan.fixture.json` — test plan fixture

---

## Chunk 1: Project Setup

### Task 1: Initialize package.json and install dependencies

**Files:**
- Create: `coachCarter/package.json`
- Create: `coachCarter/jest.config.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "coachcarter",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@supabase/supabase-js": "^2.49.0",
    "dotenv": "^16.4.0",
    "fit-file-parser": "^1.10.0",
    "garmin-connect": "^1.5.0",
    "imapflow": "^1.0.169",
    "nodemailer": "^6.9.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

- [ ] **Step 2: Create jest.config.js**

```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  clearMocks: true,
};
```

- [ ] **Step 3: Install dependencies**

Run: `cd coachCarter && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add coachCarter/package.json coachCarter/package-lock.json coachCarter/jest.config.js
git commit -m "chore: initialize coachcarter project with dependencies"
```

---

### Task 2: Environment, schema, and gitignore

**Files:**
- Create: `coachCarter/.env.example`
- Create: `coachCarter/.gitignore`
- Create: `coachCarter/supabase-setup.sql`

- [ ] **Step 1: Create .env.example**

```
# Non-sensitive vars — copy to .env and fill in
SUPABASE_URL=https://your-project.supabase.co
GARMIN_EMAIL=your-garmin-email@example.com
COACHCARTER_EMAIL=placeholder@gmail.com
ATHLETE_EMAIL=your-personal-email@example.com

# Sensitive secrets — stored in macOS Keychain, NOT here:
# security add-generic-password -s "coachcarter-garmin"    -a "$GARMIN_EMAIL"        -w "your-garmin-password"
# security add-generic-password -s "coachcarter-gmail"     -a "$COACHCARTER_EMAIL"   -w "your-16-char-app-password"
# security add-generic-password -s "coachcarter-supabase"  -a "supabase"             -w "your-service-key"
# security add-generic-password -s "coachcarter-anthropic" -a "anthropic"            -w "sk-ant-..."
```

- [ ] **Step 2: Create .gitignore**

```
.env
node_modules/
*.fit
```

- [ ] **Step 3: Create supabase-setup.sql**

```sql
create table if not exists workouts (
  id                      uuid primary key default gen_random_uuid(),
  garmin_activity_id      bigint unique not null,
  sport                   text not null,
  date                    date not null,
  day_of_week             text,
  start_time              timestamptz,
  end_time                timestamptz,
  plan_week               int,
  plan_session_id         text,
  fit_file_path           text,
  duration_min            numeric,
  calories                int,
  avg_hr                  int,
  max_hr                  int,
  hr_drift                int,
  tss                     int,
  avg_power               int,
  normalized_power        int,
  variability_index       numeric,
  intensity_factor        numeric,
  power_distribution      jsonb,
  avg_pace_sec            numeric,
  main_set_pace_sec       numeric,
  distance_km             numeric,
  efficiency              jsonb,
  intervals_detected      jsonb,
  compliance_score        int,
  compliance_breakdown    jsonb,
  email_message_id        text,
  feedback                text,
  feedback_received_at    timestamptz,
  coaching_report         text,
  status                  text default 'synced',
  created_at              timestamptz default now()
);

create table if not exists sync_state (
  id              int primary key default 1,
  last_synced_at  timestamptz
);

insert into sync_state (id, last_synced_at)
values (1, now() - interval '7 days')
on conflict (id) do nothing;

create table if not exists weekly_summaries (
  id                  uuid primary key default gen_random_uuid(),
  plan_week           int,
  week_start_date     date,
  week_end_date       date,
  overall_compliance  int,
  sessions_completed  int,
  sessions_missed     int,
  summary             text,
  created_at          timestamptz default now()
);
```

- [ ] **Step 4: Run schema in Supabase**

Open Supabase dashboard → SQL Editor → paste supabase-setup.sql → Run.
Expected: Three tables created with no errors.

- [ ] **Step 5: Commit**

```bash
git add coachCarter/.env.example coachCarter/.gitignore coachCarter/supabase-setup.sql
git commit -m "chore: add env template, gitignore, and supabase schema"
```

---

### Task 3: lib/keychain.js

**Files:**
- Create: `coachCarter/lib/keychain.js`
- Create: `coachCarter/tests/lib/keychain.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/keychain.test.js
const { execSync } = require('child_process');
jest.mock('child_process');

const { getSecret } = require('../../lib/keychain');

test('retrieves and trims secret from Keychain', () => {
  execSync.mockReturnValue(Buffer.from('mysecret\n'));
  expect(getSecret('coachcarter-garmin')).toBe('mysecret');
  expect(execSync).toHaveBeenCalledWith(
    'security find-generic-password -s "coachcarter-garmin" -w',
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
});

test('throws a clear error when secret not found', () => {
  execSync.mockImplementation(() => {
    throw new Error('SecKeychainSearchCopyNext: The specified item could not be found.');
  });
  expect(() => getSecret('nonexistent')).toThrow('Keychain secret "nonexistent" not found');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coachCarter && npx jest tests/lib/keychain.test.js`
Expected: FAIL — "Cannot find module '../../lib/keychain'"

- [ ] **Step 3: Implement lib/keychain.js**

```js
// lib/keychain.js
const { execSync } = require('child_process');

function getSecret(serviceName) {
  try {
    return execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
  } catch {
    throw new Error(
      `Keychain secret "${serviceName}" not found. ` +
      `Run: security add-generic-password -s "${serviceName}" -w <value>`
    );
  }
}

module.exports = { getSecret };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/keychain.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/keychain.js coachCarter/tests/lib/keychain.test.js
git commit -m "feat: add keychain helper for macOS secret retrieval"
```

---

### Task 4: lib/supabase.js

**Files:**
- Create: `coachCarter/lib/supabase.js`
- Create: `coachCarter/tests/lib/supabase.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/supabase.test.js
// Use jest.isolateModules to control module registry per test (required for singleton testing)

test('creates client with SUPABASE_URL and Keychain service key', () => {
  jest.isolateModules(() => {
    jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn().mockReturnValue({ from: jest.fn() }) }));
    jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('service-key-abc') }));
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    const { createClient } = require('@supabase/supabase-js');
    const { getSupabase } = require('../../lib/supabase');
    getSupabase();
    expect(createClient).toHaveBeenCalledWith('https://test.supabase.co', 'service-key-abc');
  });
});

test('returns the same client instance on repeated calls (singleton)', () => {
  jest.isolateModules(() => {
    jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn().mockReturnValue({ from: jest.fn() }) }));
    jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('service-key-abc') }));
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    const { createClient } = require('@supabase/supabase-js');
    const { getSupabase } = require('../../lib/supabase');
    const a = getSupabase();
    const b = getSupabase();
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/supabase.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/supabase.js**

```js
// lib/supabase.js
const { createClient } = require('@supabase/supabase-js');
const { getSecret } = require('./keychain');

let _client = null;

function getSupabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL not set in environment');
    const key = getSecret('coachcarter-supabase');
    _client = createClient(url, key);
  }
  return _client;
}

module.exports = { getSupabase };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/lib/supabase.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/supabase.js coachCarter/tests/lib/supabase.test.js
git commit -m "feat: add supabase client factory with keychain auth"
```

---

## Chunk 2: Garmin Sync

### Task 5: lib/garmin.js

**Files:**
- Create: `coachCarter/lib/garmin.js`
- Create: `coachCarter/tests/lib/garmin.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/garmin.test.js
jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(undefined),
    getActivities: jest.fn(),
    downloadOriginalActivityData: jest.fn(),
  })),
}));
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('garmin-pass') }));

process.env.GARMIN_EMAIL = 'test@example.com';

const { createGarminClient, getActivitiesSince, resolveSource, deduplicateBikes } =
  require('../../lib/garmin');

test('createGarminClient logs in with email + Keychain password', async () => {
  const client = await createGarminClient();
  expect(client.login).toHaveBeenCalledWith('test@example.com', 'garmin-pass');
});

test('getActivitiesSince filters activities after the given date', async () => {
  const since = new Date('2026-03-18T00:00:00Z');
  const activities = [
    { activityId: 1, startTimeGMT: '2026-03-19 08:00:00' },
    { activityId: 2, startTimeGMT: '2026-03-17 08:00:00' },
  ];
  const client = { getActivities: jest.fn().mockResolvedValue(activities) };
  const result = await getActivitiesSince(client, since);
  expect(result).toHaveLength(1);
  expect(result[0].activityId).toBe(1);
});

test('resolveSource returns "zwift" for virtual_ride activities', () => {
  expect(resolveSource({ activityType: { typeKey: 'virtual_ride' } })).toBe('zwift');
});

test('resolveSource returns "watch" for regular cycling', () => {
  expect(resolveSource({ activityType: { typeKey: 'cycling' } })).toBe('watch');
});

test('deduplicateBikes prefers Zwift when both sources present on same day', () => {
  const activities = [
    { activityId: 10, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'virtual_ride' } },
    { activityId: 11, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
    { activityId: 12, sport: 'run',  date: '2026-03-18', activityType: { typeKey: 'running' } },
  ];
  const result = deduplicateBikes(activities);
  expect(result.map(a => a.activityId)).toEqual([10, 12]);
});

test('deduplicateBikes keeps all activities when source cannot be determined', () => {
  const activities = [
    { activityId: 20, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
    { activityId: 21, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
  ];
  const result = deduplicateBikes(activities);
  expect(result).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/garmin.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/garmin.js**

```js
// lib/garmin.js
const { GarminConnect } = require('garmin-connect');
const { getSecret } = require('./keychain');

async function createGarminClient() {
  const email = process.env.GARMIN_EMAIL;
  const password = getSecret('coachcarter-garmin');
  const client = new GarminConnect({ username: email, password });
  await client.login(email, password);
  return client;
}

async function getActivitiesSince(client, since) {
  const activities = await client.getActivities(0, 100);
  return activities.filter(a => new Date(a.startTimeGMT) > since);
}

async function downloadFitFile(client, activityId) {
  return client.downloadOriginalActivityData(activityId, '.fit');
}

// Returns 'zwift' if identifiable as Zwift-sourced, else 'watch'.
function resolveSource(activity) {
  const typeKey = activity.activityType?.typeKey || '';
  if (typeKey === 'virtual_ride') return 'zwift';
  return 'watch';
}

// For days with multiple bike activities, prefer Zwift-sourced if identifiable.
// If both are 'watch' (source indeterminate), keep all — analyze both.
function deduplicateBikes(activities) {
  const bikes = activities.filter(a => a.sport === 'bike');
  const others = activities.filter(a => a.sport !== 'bike');

  const byDate = {};
  for (const a of bikes) {
    if (!byDate[a.date]) byDate[a.date] = [];
    byDate[a.date].push(a);
  }

  const keep = [];
  for (const group of Object.values(byDate)) {
    if (group.length === 1) { keep.push(...group); continue; }
    const zwift = group.find(a => resolveSource(a) === 'zwift');
    if (zwift) {
      keep.push(zwift);
      console.log(`[garmin] Kept Zwift bike on ${group[0].date}, dropped ${group.length - 1} watch duplicate(s)`);
    } else {
      keep.push(...group);
      console.log(`[garmin] Multiple bike activities on ${group[0].date} — source unknown, keeping all`);
    }
  }

  return [...keep, ...others];
}

module.exports = { createGarminClient, getActivitiesSince, downloadFitFile, resolveSource, deduplicateBikes };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/lib/garmin.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/garmin.js coachCarter/tests/lib/garmin.test.js
git commit -m "feat: add garmin client with activity fetch and bike deduplication"
```

---

### Task 6: scripts/sync-garmin.js + skill

**Files:**
- Create: `coachCarter/scripts/sync-garmin.js`
- Create: `coachCarter/tests/scripts/sync-garmin.test.js`
- Create: `coachCarter/skills/sync-garmin.md`

- [ ] **Step 1: Write failing tests**

```js
// tests/scripts/sync-garmin.test.js
jest.mock('../../lib/garmin');
jest.mock('../../lib/supabase');
jest.mock('../../scripts/analyze-workout', () => ({ run: jest.fn().mockResolvedValue(undefined) }));

const garmin = require('../../lib/garmin');
const { getSupabase } = require('../../lib/supabase');
const { run: analyzeWorkout } = require('../../scripts/analyze-workout');

const mockInsertChain = { select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'uuid-new' }, error: null }) };
const mockDb = {
  from: jest.fn(),
  select: jest.fn(),
  eq: jest.fn(),
  single: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  lt: jest.fn(),
  storage: { from: jest.fn() },
};

['from','select','eq','lt','update'].forEach(m => mockDb[m].mockReturnValue(mockDb));
mockDb.single.mockResolvedValue({ data: { last_synced_at: new Date().toISOString() }, error: null });
mockDb.insert.mockReturnValue(mockInsertChain);
mockDb.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  garmin.createGarminClient.mockResolvedValue({});
  garmin.getActivitiesSince.mockResolvedValue([]);
  garmin.deduplicateBikes.mockImplementation(a => a);
});

test('reads last_synced_at from sync_state before fetching', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('sync_state');
});

test('updates last_synced_at after sync completes', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.update).toHaveBeenCalled();
});

test('calls analyzeWorkout inline for each new activity', async () => {
  garmin.getActivitiesSince.mockResolvedValue([
    { activityId: 123, activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-03-18 08:00:00' },
  ]);
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(analyzeWorkout).toHaveBeenCalledWith('uuid-new');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/scripts/sync-garmin.test.js`
Expected: FAIL

- [ ] **Step 3: Implement scripts/sync-garmin.js**

```js
// scripts/sync-garmin.js
require('dotenv').config();
const { createGarminClient, getActivitiesSince, downloadFitFile, deduplicateBikes } = require('../lib/garmin');
const { getSupabase } = require('../lib/supabase');
const { run: analyzeWorkout } = require('./analyze-workout');

async function run() {
  const db = getSupabase();

  // 1. Read last_synced_at
  const { data: state } = await db.from('sync_state').select('last_synced_at').eq('id', 1).single();
  const since = new Date(state.last_synced_at);
  console.log(`[sync-garmin] Syncing since ${since.toISOString()}`);

  // 2. Auth + fetch
  const client = await createGarminClient();
  let activities = await getActivitiesSince(client, since);
  activities = deduplicateBikes(activities);
  console.log(`[sync-garmin] ${activities.length} new activities`);

  // 3. Process each — store then immediately analyze inline
  for (const activity of activities) {
    const workoutId = await processActivity(client, db, activity);
    if (workoutId) {
      try {
        await analyzeWorkout(workoutId);
      } catch (err) {
        console.error(`[sync-garmin] analyze-workout failed for ${workoutId}:`, err.message);
        // Row stays at status="synced" and will be retried on next cron run
      }
    }
  }

  // 4. Retry rows stuck at status="synced" older than 10 minutes
  await retryStuck(db);

  // 5. Update sync_state
  await db.from('sync_state').update({ last_synced_at: new Date().toISOString() }).eq('id', 1);
  console.log('[sync-garmin] Done');
}

// Returns the new workout UUID, or null on failure
async function processActivity(client, db, activity) {
  const { activityId, activityType, startTimeLocal } = activity;
  const sport = normalizeSport(activityType?.typeKey);
  const date = startTimeLocal?.split(' ')[0];

  const fitBuffer = await downloadFitFile(client, activityId);
  const fitPath = `fit-files/${date}_${sport}_${activityId}.fit`;

  const { error: uploadError } = await db.storage.from('fit-files').upload(fitPath, fitBuffer);
  if (uploadError) {
    console.error(`[sync-garmin] Upload failed for ${activityId}:`, uploadError.message);
    return null;
  }

  const { data: inserted, error: insertError } = await db.from('workouts').insert({
    garmin_activity_id: activityId,
    sport,
    date,
    day_of_week: getDayOfWeek(startTimeLocal),
    start_time: startTimeLocal,
    fit_file_path: fitPath,
    status: 'synced',
  }).select('id').single();

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`[sync-garmin] Activity ${activityId} already stored — skipping`);
    } else {
      console.error(`[sync-garmin] Insert failed for ${activityId}:`, insertError.message);
    }
    return null;
  }

  console.log(`[sync-garmin] Stored ${sport} ${activityId} → ${inserted.id}`);
  return inserted.id;
}

async function retryStuck(db) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuck } = await db.from('workouts').select('id').eq('status', 'synced').lt('created_at', cutoff);
  if (!stuck?.length) return;
  console.log(`[sync-garmin] Retrying ${stuck.length} stuck rows`);
  for (const { id } of stuck) {
    try { await analyzeWorkout(id); }
    catch (err) { console.error(`[sync-garmin] Retry failed for ${id}:`, err.message); }
  }
}

function normalizeSport(typeKey = '') {
  if (typeKey.includes('cycling') || typeKey === 'virtual_ride') return 'bike';
  if (typeKey.includes('running')) return 'run';
  if (typeKey.includes('swimming')) return 'swim';
  if (typeKey.includes('strength') || typeKey.includes('training')) return 'strength';
  return typeKey || 'unknown';
}

function getDayOfWeek(dateStr) {
  if (!dateStr) return null;
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(dateStr).getDay()];
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/scripts/sync-garmin.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Create skills/sync-garmin.md**

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add coachCarter/scripts/sync-garmin.js coachCarter/tests/scripts/sync-garmin.test.js coachCarter/skills/sync-garmin.md
git commit -m "feat: add sync-garmin script and skill"
```

---

## Chunk 3: FIT Parsing

### Task 7: lib/fit-parser.js

**Files:**
- Create: `coachCarter/lib/fit-parser.js`
- Create: `coachCarter/tests/lib/fit-parser.test.js`

The parser takes a raw FIT buffer and sport type, and returns a flat metrics object. All calculations (NP, TSS, HR drift, interval detection, swim pace estimation) live here.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/fit-parser.test.js
const mockRecords = Array.from({ length: 120 }, (_, i) => ({
  power: 185 + Math.floor(i / 10) * 3,
  heart_rate: 140 + Math.floor(i / 30),
  speed: 8.5,
  timestamp: new Date(Date.now() + i * 30000),
}));

const mockFitData = {
  activity: {
    sessions: [{
      total_elapsed_time: 3600,
      total_calories: 450,
      start_time: new Date('2026-03-18T06:00:00Z'),
      timestamp: new Date('2026-03-18T07:00:00Z'),
      avg_heart_rate: 145,
      max_heart_rate: 165,
      avg_power: 185,
      total_distance: 30000,
      laps: [{ records: mockRecords }],
    }],
  },
};

jest.mock('fit-file-parser', () => ({
  default: jest.fn().mockImplementation(() => ({
    parse: jest.fn((buf, cb) => cb(null, mockFitData)),
  })),
}));

const { parseFit, extractMetrics } = require('../../lib/fit-parser');

test('parseFit resolves with structured fit data', async () => {
  const result = await parseFit(Buffer.from('fake'));
  expect(result).toBe(mockFitData);
});

const athlete = { ftp: 190, run_threshold_sec_per_km: 290 };

test('extractMetrics returns base fields for strength', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'strength', athlete);
  expect(metrics.duration_min).toBeCloseTo(60, 0);
  expect(metrics.calories).toBe(450);
  expect(metrics.avg_power).toBeUndefined();
});

test('extractMetrics includes power fields for bike', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'bike', athlete);
  expect(metrics.avg_power).toBe(185);
  expect(metrics.normalized_power).toBeDefined();
  expect(metrics.tss).toBeDefined();
  expect(metrics.intervals_detected).toBeDefined();
  expect(metrics.power_distribution).toBeDefined();
});

test('extractMetrics includes pace and distance for run', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'run', athlete);
  expect(metrics.avg_pace_sec).toBeDefined();
  expect(metrics.distance_km).toBeCloseTo(30, 0);
});

test('extractMetrics includes distance and pace for swim', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'swim', athlete);
  expect(metrics.total_distance_m).toBeDefined();
  expect(metrics.avg_pace_sec).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/fit-parser.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/fit-parser.js**

```js
// lib/fit-parser.js
const FitParser = require('fit-file-parser').default;

function parseFit(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'km' });
    parser.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

// athlete = { ftp, run_threshold_sec_per_km } — passed from plan.json at call site
async function extractMetrics(buffer, sport, athlete = {}) {
  const data = await parseFit(buffer);
  const session = data.activity?.sessions?.[0] || {};
  const records = session.laps?.flatMap(l => l.records || []) || [];

  const base = {
    duration_min: session.total_elapsed_time ? +(session.total_elapsed_time / 60).toFixed(1) : null,
    calories: session.total_calories || null,
    start_time: session.start_time || null,
    end_time: session.timestamp || null,
  };

  if (sport === 'strength') return base;

  const avg_hr = session.avg_heart_rate || null;
  const max_hr = session.max_heart_rate || null;
  const distance_km = session.total_distance ? +(session.total_distance / 1000).toFixed(2) : null;
  const ftp = athlete.ftp;
  const runThreshold = athlete.run_threshold_sec_per_km;

  if (sport === 'bike') {
    if (!ftp) throw new Error('extractMetrics: athlete.ftp is required for bike sport');
    const powerRecords = records.map(r => r.power).filter(Boolean);
    const avg_power = session.avg_power || (powerRecords.length ? Math.round(mean(powerRecords)) : null);
    const normalized_power = calculateNP(powerRecords);
    const variability_index = (normalized_power && avg_power) ? +(normalized_power / avg_power).toFixed(3) : null;
    const intensity_factor = normalized_power ? +(normalized_power / ftp).toFixed(3) : null;
    const tss = (normalized_power && intensity_factor && session.total_elapsed_time)
      ? Math.round((session.total_elapsed_time * normalized_power * intensity_factor) / (ftp * 3600) * 100)
      : null;
    const hr_drift = calculateHrDrift(records);
    const power_distribution = calculatePowerZones(powerRecords, ftp);
    const intervals_detected = detectIntervals(powerRecords, ftp);
    return { ...base, avg_hr, max_hr, hr_drift, avg_power, normalized_power, variability_index,
      intensity_factor, tss, power_distribution, distance_km,
      efficiency: { hr_drift }, intervals_detected };
  }

  if (sport === 'run') {
    if (!runThreshold) throw new Error('extractMetrics: athlete.run_threshold_sec_per_km is required for run sport');
    const speedRecords = records.map(r => r.speed).filter(Boolean);
    const avg_speed_kmh = speedRecords.length ? mean(speedRecords) : null;
    const avg_pace_sec = avg_speed_kmh ? Math.round(3600 / avg_speed_kmh) : null;
    const hr_drift = calculateHrDrift(records);
    const tss = calculateRunTSS(session.total_elapsed_time, avg_pace_sec, runThreshold);
    return { ...base, avg_hr, max_hr, hr_drift, avg_pace_sec, distance_km, tss,
      efficiency: { hr_drift } };
  }

  if (sport === 'swim') {
    const total_distance_m = session.total_distance ? Math.round(session.total_distance) : null;
    const avg_speed_ms = (total_distance_m && session.total_elapsed_time)
      ? total_distance_m / session.total_elapsed_time : null;
    const avg_pace_sec = avg_speed_ms ? Math.round(100 / avg_speed_ms) : null;
    // estimateMainSetPace uses record speed values — note: FIT swim records report speed
    // in m/s regardless of the parser's speedUnit option. No km/h conversion is applied here.
    const main_set_pace_sec = estimateMainSetPaceSwim(records);
    return { ...base, avg_hr, total_distance_m, avg_pace_sec, main_set_pace_sec, distance_km };
  }

  return base;
}

// --- Calculation helpers ---

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateNP(powerRecords) {
  if (powerRecords.length < 30) return null;
  const windowSize = 30;
  const rolling = [];
  for (let i = windowSize - 1; i < powerRecords.length; i++) {
    rolling.push(mean(powerRecords.slice(i - windowSize + 1, i + 1)));
  }
  return Math.round(Math.pow(mean(rolling.map(v => Math.pow(v, 4))), 0.25));
}

function calculateHrDrift(records) {
  const hrs = records.map(r => r.heart_rate).filter(Boolean);
  if (hrs.length < 20) return null;
  const mid = Math.floor(hrs.length / 2);
  const firstHalf = mean(hrs.slice(0, mid));
  const secondHalf = mean(hrs.slice(mid));
  return Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
}

function calculatePowerZones(powerRecords, ftp) {
  if (!powerRecords.length) return null;
  const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const p of powerRecords) {
    const pct = p / ftp;
    if (pct < 0.56) zones.z1++;
    else if (pct < 0.76) zones.z2++;
    else if (pct < 0.91) zones.z3++;
    else if (pct < 1.06) zones.z4++;
    else zones.z5++;
  }
  const total = powerRecords.length;
  return Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, Math.round(v / total * 100)]));
}

function detectIntervals(powerRecords, ftp) {
  if (!powerRecords.length) return null;
  const threshold = ftp * 0.85;
  let inInterval = false;
  let intervalCount = 0;
  const workPowers = [];
  let currentWork = [];

  for (const p of powerRecords) {
    if (p >= threshold) {
      if (!inInterval) { inInterval = true; intervalCount++; currentWork = []; }
      currentWork.push(p);
    } else {
      if (inInterval) {
        inInterval = false;
        if (currentWork.length >= 5) workPowers.push(...currentWork);
      }
    }
  }
  return {
    work_intervals: intervalCount,
    avg_work_power: workPowers.length ? Math.round(mean(workPowers)) : null,
  };
}

function calculateRunTSS(durationSec, avgPaceSec, runThresholdSecPerKm) {
  if (!durationSec || !avgPaceSec || !runThresholdSecPerKm) return null;
  const intensityFactor = runThresholdSecPerKm / avgPaceSec;
  return Math.round((durationSec * intensityFactor * intensityFactor) / 3600 * 100);
}

// Swim record speed values are in m/s (FIT spec, unaffected by parser speedUnit option)
function estimateMainSetPaceSwim(records) {
  const speeds = records.map(r => r.speed).filter(Boolean); // m/s
  if (speeds.length < 10) return null;
  const windowSize = Math.min(10, Math.floor(speeds.length / 3));
  let bestAvg = 0;
  for (let i = 0; i <= speeds.length - windowSize; i++) {
    const w = mean(speeds.slice(i, i + windowSize));
    if (w > bestAvg) bestAvg = w;
  }
  // Convert m/s → sec/100m
  return bestAvg ? Math.round(100 / bestAvg) : null;
}

module.exports = { parseFit, extractMetrics };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/lib/fit-parser.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/fit-parser.js coachCarter/tests/lib/fit-parser.test.js
git commit -m "feat: add FIT parser with sport-specific metric extraction"
```

---

## Chunk 4: Plan Matching

### Task 8: plan.json stub + lib/plan.js

**Files:**
- Create: `coachCarter/plan.json`
- Create: `coachCarter/lib/plan.js`
- Create: `coachCarter/tests/lib/plan.test.js`
- Create: `coachCarter/tests/fixtures/plan.fixture.json`

- [ ] **Step 1: Create plan.json stub**

```json
{
  "plan_name": "Offseason Base Block",
  "plan_start_date": "2026-03-17",
  "athlete": {
    "ftp": 190,
    "weight": 72,
    "lthr": 165,
    "run_threshold_sec_per_km": 290,
    "swim_css_sec_per_100m": 180
  },
  "weeks": []
}
```

**Important:** The `weeks` array must be populated from `offseason_training_plan.xlsx` before running `/analyze-workout`. Without sessions, all workouts will be tagged `unplanned`. See `offseason_training_plan.xlsx` → "Workout Library" sheet for prescriptions.

- [ ] **Step 2: Write the failing tests**

```js
// tests/lib/plan.test.js
const path = require('path');
const fs = require('fs');

// Point to fixture to avoid coupling tests to the real plan.json
process.env.PLAN_PATH = path.join(__dirname, '../fixtures/plan.fixture.json');

const fixturePlan = {
  plan_start_date: '2026-03-17',
  athlete: { ftp: 190, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 },
  weeks: [{
    week: 1,
    sessions: [
      { id: 'mon_bike',     day: 'Monday',    sport: 'bike',     type: 'intervals' },
      { id: 'tue_strength', day: 'Tuesday',   sport: 'strength', type: 'A' },
      { id: 'wed_swim',     day: 'Wednesday', sport: 'swim',     type: 'technique' },
      { id: 'thu_strength', day: 'Thursday',  sport: 'strength', type: 'B' },
      { id: 'sat_bike',     day: 'Saturday',  sport: 'bike',     type: 'z2' },
      { id: 'sat_run',      day: 'Saturday',  sport: 'run',      type: 'z2' },
      { id: 'sun_swim',     day: 'Sunday',    sport: 'swim',     type: 'easy' },
      { id: 'sun_run',      day: 'Sunday',    sport: 'run',      type: 'z2' },
    ],
  }],
};

beforeAll(() => {
  const dir = path.join(__dirname, '../fixtures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(process.env.PLAN_PATH, JSON.stringify(fixturePlan));
});

const { loadPlan, calcPlanWeek, matchSession } = require('../../lib/plan');

test('loadPlan returns parsed plan object', () => {
  const plan = loadPlan();
  expect(plan.plan_start_date).toBe('2026-03-17');
  expect(plan.weeks).toHaveLength(1);
});

test('calcPlanWeek returns 1 for the first week', () => {
  expect(calcPlanWeek('2026-03-17', '2026-03-17')).toBe(1);
  expect(calcPlanWeek('2026-03-17', '2026-03-23')).toBe(1);
});

test('calcPlanWeek cycles: week 4 rolls over to week 1', () => {
  expect(calcPlanWeek('2026-03-17', '2026-04-13')).toBe(4);
  expect(calcPlanWeek('2026-03-17', '2026-04-14')).toBe(1);
});

test('matchSession returns matching session for day+sport', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Monday', 'bike').id).toBe('mon_bike');
});

test('matchSession returns null for unplanned activity', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Friday', 'run')).toBeNull();
});

test('matchSession distinguishes same-day sessions by sport', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Saturday', 'bike').id).toBe('sat_bike');
  expect(matchSession(plan, 1, 'Saturday', 'run').id).toBe('sat_run');
});

test('matchSession matches strength sessions by day', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Tuesday', 'strength').id).toBe('tue_strength');
  expect(matchSession(plan, 1, 'Thursday', 'strength').id).toBe('thu_strength');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest tests/lib/plan.test.js`
Expected: FAIL

- [ ] **Step 4: Implement lib/plan.js**

```js
// lib/plan.js
const fs = require('fs');
const path = require('path');

function getPlanPath() {
  return process.env.PLAN_PATH || path.join(__dirname, '../plan.json');
}

function loadPlan() {
  return JSON.parse(fs.readFileSync(getPlanPath(), 'utf8'));
}

// Returns 1–4, cycling indefinitely
function calcPlanWeek(planStartDate, activityDate) {
  const start = new Date(planStartDate);
  const activity = new Date(activityDate);
  const daysDiff = Math.floor((activity - start) / (1000 * 60 * 60 * 24));
  return (Math.floor(daysDiff / 7) % 4) + 1;
}

// Returns the matching session object or null
function matchSession(plan, planWeek, dayOfWeek, sport) {
  const week = plan.weeks.find(w => w.week === planWeek);
  if (!week) return null;
  return week.sessions.find(s => s.day === dayOfWeek && s.sport === sport) || null;
}

module.exports = { loadPlan, calcPlanWeek, matchSession };
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/lib/plan.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add coachCarter/plan.json coachCarter/lib/plan.js coachCarter/tests/lib/plan.test.js
git commit -m "feat: add plan loader and session matching logic"
```

---

## Chunk 5: Compliance Scoring

### Task 9: lib/compliance.js

**Files:**
- Create: `coachCarter/lib/compliance.js`
- Create: `coachCarter/tests/lib/compliance.test.js`

Compliance scoring compares actual FIT metrics against plan.json targets for the matched session. All thresholds come from `session.targets` — nothing hardcoded. Returns `{ score: 0–100, breakdown: {} }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/compliance.test.js
const { scoreCompliance } = require('../../lib/compliance');

const bikeSession = {
  sport: 'bike', type: 'intervals', duration_min: 60,
  targets: { main_set: { sets: 3, power_min: 171, power_max: 181 }, vi_max: 1.05, duration_min: 60 },
};

test('bike: full compliance returns 100', () => {
  const metrics = { intervals_detected: { work_intervals: 3 }, normalized_power: 175, variability_index: 1.02, duration_min: 60 };
  expect(scoreCompliance(bikeSession, metrics).score).toBe(100);
});

test('bike: missed all intervals reduces score significantly', () => {
  const metrics = { intervals_detected: { work_intervals: 0 }, normalized_power: 175, variability_index: 1.02, duration_min: 60 };
  const { score, breakdown } = scoreCompliance(bikeSession, metrics);
  expect(score).toBeLessThan(80);
  expect(breakdown.intervals).toBe(false);
});

test('bike: power out of range reduces score', () => {
  const metrics = { intervals_detected: { work_intervals: 3 }, normalized_power: 150, variability_index: 1.02, duration_min: 60 };
  expect(scoreCompliance(bikeSession, metrics).score).toBeLessThan(100);
});

const runSession = {
  sport: 'run', type: 'z2', duration_min: 30,
  targets: { pace_min_sec: 345, pace_max_sec: 375, hr_max: 145, duration_min: 30 },
};

test('run: in-zone pace and HR returns 100', () => {
  expect(scoreCompliance(runSession, { avg_pace_sec: 360, avg_hr: 140, duration_min: 30 }).score).toBe(100);
});

test('run: HR over limit reduces score', () => {
  expect(scoreCompliance(runSession, { avg_pace_sec: 360, avg_hr: 160, duration_min: 30 }).score).toBeLessThan(100);
});

const swimSession = {
  sport: 'swim', type: 'technique', duration_min: 60,
  // Note: field name is css_target_sec_per_100m per plan.json schema;
  // compliance scorer reads targets.main_set.css_target_sec_per_100m
  targets: { total_distance_m: 2200, main_set: { css_target_sec_per_100m: 180 } },
};

test('swim: on-target pace and distance returns 100', () => {
  expect(scoreCompliance(swimSession, { main_set_pace_sec: 180, total_distance_m: 2200 }).score).toBe(100);
});

test('swim: short distance reduces score', () => {
  expect(scoreCompliance(swimSession, { main_set_pace_sec: 180, total_distance_m: 1800 }).score).toBeLessThan(100);
});

test('strength: returns null score (email-only)', () => {
  expect(scoreCompliance({ sport: 'strength' }, {}).score).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/compliance.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/compliance.js**

```js
// lib/compliance.js

function scoreCompliance(session, metrics) {
  const { sport } = session;
  const targets = session.targets || {};

  if (sport === 'strength') return { score: null, breakdown: { note: 'scored from email reply' } };
  if (sport === 'bike')     return scoreBike(targets, metrics);
  if (sport === 'run')      return scoreRun(targets, metrics);
  if (sport === 'swim')     return scoreSwim(targets, metrics);
  return { score: null, breakdown: { note: `no scorer for sport: ${sport}` } };
}

function scoreBike(targets, metrics) {
  const factors = [];
  const breakdown = {};

  const sets = targets.main_set?.sets;
  const actual = metrics.intervals_detected?.work_intervals;
  if (sets != null && actual != null) {
    breakdown.intervals = actual >= sets;
    factors.push({ pass: breakdown.intervals, weight: 3 });
  }

  const { power_min, power_max } = targets.main_set || {};
  const np = metrics.normalized_power;
  if (power_min != null && power_max != null && np != null) {
    breakdown.power_in_range = np >= power_min && np <= power_max;
    factors.push({ pass: breakdown.power_in_range, weight: 3 });
  }

  if (targets.vi_max != null && metrics.variability_index != null) {
    breakdown.vi_ok = metrics.variability_index <= targets.vi_max;
    factors.push({ pass: breakdown.vi_ok, weight: 2 });
  }

  if (targets.duration_min != null && metrics.duration_min != null) {
    breakdown.duration_ok = Math.abs(metrics.duration_min - targets.duration_min) / targets.duration_min <= 0.15;
    factors.push({ pass: breakdown.duration_ok, weight: 2 });
  }

  return { score: calcScore(factors), breakdown };
}

function scoreRun(targets, metrics) {
  const factors = [];
  const breakdown = {};

  if (targets.pace_min_sec != null && metrics.avg_pace_sec != null) {
    breakdown.pace_in_range = metrics.avg_pace_sec >= targets.pace_min_sec && metrics.avg_pace_sec <= targets.pace_max_sec;
    factors.push({ pass: breakdown.pace_in_range, weight: 4 });
  }

  if (targets.hr_max != null && metrics.avg_hr != null) {
    breakdown.hr_ok = metrics.avg_hr <= targets.hr_max;
    factors.push({ pass: breakdown.hr_ok, weight: 4 });
  }

  if (targets.duration_min != null && metrics.duration_min != null) {
    breakdown.duration_ok = Math.abs(metrics.duration_min - targets.duration_min) / targets.duration_min <= 0.15;
    factors.push({ pass: breakdown.duration_ok, weight: 2 });
  }

  return { score: calcScore(factors), breakdown };
}

function scoreSwim(targets, metrics) {
  const factors = [];
  const breakdown = {};

  const targetPace = targets.main_set?.css_target_sec_per_100m;
  if (targetPace != null && metrics.main_set_pace_sec != null) {
    breakdown.pace_ok = Math.abs(metrics.main_set_pace_sec - targetPace) <= 5;
    factors.push({ pass: breakdown.pace_ok, weight: 5 });
  }

  if (targets.total_distance_m != null && metrics.total_distance_m != null) {
    breakdown.distance_ok = metrics.total_distance_m >= targets.total_distance_m * 0.95;
    factors.push({ pass: breakdown.distance_ok, weight: 5 });
  }

  return { score: calcScore(factors), breakdown };
}

// Weighted pass/fail → 0–100
function calcScore(factors) {
  if (!factors.length) return null;
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const passedWeight = factors.filter(f => f.pass).reduce((s, f) => s + f.weight, 0);
  return Math.round((passedWeight / totalWeight) * 100);
}

module.exports = { scoreCompliance };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/lib/compliance.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/compliance.js coachCarter/tests/lib/compliance.test.js
git commit -m "feat: add compliance scoring against plan.json targets"
```

---

## Chunk 6: Email

### Task 10: lib/email.js

**Files:**
- Create: `coachCarter/lib/email.js`
- Create: `coachCarter/tests/lib/email.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/email.test.js
jest.mock('nodemailer');
jest.mock('imapflow');
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('app-password') }));

process.env.COACHCARTER_EMAIL = 'coachcarter@gmail.com';

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const mockTransporter = { sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@gmail.com>' }) };
nodemailer.createTransport.mockReturnValue(mockTransporter);

const { sendFeedbackEmail, pollReplies } = require('../../lib/email');

test('sendFeedbackEmail uses Gmail SMTP with Keychain App Password', async () => {
  await sendFeedbackEmail({ to: 'nayan@example.com', subject: 'Test', body: 'Hello' });
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
    host: 'smtp.gmail.com',
    auth: expect.objectContaining({ user: 'coachcarter@gmail.com', pass: 'app-password' }),
  }));
});

test('sendFeedbackEmail returns the SMTP message_id', async () => {
  const result = await sendFeedbackEmail({ to: 'nayan@example.com', subject: 'Test', body: 'Hello' });
  expect(result.messageId).toBe('<abc@gmail.com>');
});

test('pollReplies connects via IMAP with CoachCarter credentials', async () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    mailboxOpen: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  ImapFlow.mockImplementation(() => mockClient);

  await pollReplies({ onReply: jest.fn() });
  expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({
    host: 'imap.gmail.com',
    auth: expect.objectContaining({ user: 'coachcarter@gmail.com', pass: 'app-password' }),
  }));
  expect(mockClient.connect).toHaveBeenCalled();
});

test('pollReplies calls onReply with inReplyTo and body when messages found', async () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    mailboxOpen: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([42]),
    fetchOne: jest.fn().mockResolvedValue({
      envelope: { messageId: '<reply@gmail.com>', inReplyTo: '<original@gmail.com>' },
      source: Buffer.from('Great session, 8/10.'),
    }),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  ImapFlow.mockImplementation(() => mockClient);

  const onReply = jest.fn().mockResolvedValue(undefined);
  await pollReplies({ onReply });

  expect(onReply).toHaveBeenCalledWith(expect.objectContaining({
    inReplyTo: '<original@gmail.com>',
    body: expect.stringContaining('Great session'),
  }));
  expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(42, ['\\Seen']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/email.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/email.js**

```js
// lib/email.js
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { getSecret } = require('./keychain');

function createTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.COACHCARTER_EMAIL,
      pass: getSecret('coachcarter-gmail'),
    },
  });
}

async function sendFeedbackEmail({ to, subject, body }) {
  const transport = createTransport();
  const result = await transport.sendMail({
    from: process.env.COACHCARTER_EMAIL,
    to,
    subject,
    text: body,
  });
  return { messageId: result.messageId };
}

// Polls the dedicated CoachCarter inbox for unseen messages.
// Calls onReply({ uid, messageId, inReplyTo, body }) for each message that has In-Reply-To set.
async function pollReplies({ onReply, sinceDate } = {}) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.COACHCARTER_EMAIL,
      pass: getSecret('coachcarter-gmail'),
    },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  const since = sinceDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const uids = await client.search({ since, seen: false });

  for (const uid of uids) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true });
    const inReplyTo = msg.envelope?.inReplyTo;
    const body = msg.source?.toString();
    if (inReplyTo && onReply) {
      await onReply({ uid, messageId: msg.envelope?.messageId, inReplyTo, body });
    }
    await client.messageFlagsAdd(uid, ['\\Seen']);
  }

  await client.logout();
  return uids.length;
}

module.exports = { sendFeedbackEmail, pollReplies };
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/lib/email.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add coachCarter/lib/email.js coachCarter/tests/lib/email.test.js
git commit -m "feat: add email module with nodemailer SMTP and imapflow IMAP poll"
```

---

## Chunk 7: Analyze Workout Pipeline

### Task 11: lib/email-templates.js + scripts/analyze-workout.js + skill

**Files:**
- Create: `coachCarter/lib/email-templates.js`
- Create: `coachCarter/scripts/analyze-workout.js`
- Create: `coachCarter/tests/scripts/analyze-workout.test.js`
- Create: `coachCarter/skills/analyze-workout.md`

- [ ] **Step 1: Create lib/email-templates.js**

```js
// lib/email-templates.js

function buildEmailBody(workout, metrics, session) {
  const { sport, day_of_week } = workout;

  if (!session) {
    return `Unplanned ${sport} detected — ${metrics.duration_min}min` +
      (metrics.distance_km ? `, ${metrics.distance_km}km` : '') +
      `.\nNo prescription to match. How did it go and what was this session for?`;
  }

  if (sport === 'bike')     return buildBikeEmail(metrics, session);
  if (sport === 'run')      return buildRunEmail(metrics, session);
  if (sport === 'swim')     return buildSwimEmail(metrics, session);
  if (sport === 'strength') return buildStrengthEmail(metrics, session, day_of_week);
  return `${day_of_week} ${sport} done — ${metrics.duration_min}min. How did it go?`;
}

function buildBikeEmail(metrics, session) {
  const t = session.targets?.main_set || {};
  const np = metrics.normalized_power;
  const inRange = np && t.power_min && np >= t.power_min && np <= t.power_max;
  return [
    `${session.day} bike done. ${metrics.duration_min}min,`,
    np ? `NP ${np}W (target ${t.power_min}–${t.power_max}W ${inRange ? '✓' : '✗'}),` : '',
    metrics.variability_index ? `VI ${metrics.variability_index} ${metrics.variability_index <= session.targets?.vi_max ? '✓' : '✗'},` : '',
    metrics.intervals_detected ? `${metrics.intervals_detected.work_intervals}/${t.sets} intervals,` : '',
    `TSS ${metrics.tss || '—'} (target ${session.targets?.tss_target || '—'}).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].filter(Boolean).join(' ');
}

function buildRunEmail(metrics, session) {
  const t = session.targets || {};
  return [
    `${session.day} run done. ${metrics.duration_min}min,`,
    `avg pace ${metrics.avg_pace_sec ? formatPace(metrics.avg_pace_sec) : '—'}/km`,
    `(target ${t.pace_min_sec ? formatPace(t.pace_min_sec) : '—'}–${t.pace_max_sec ? formatPace(t.pace_max_sec) : '—'}/km),`,
    `avg HR ${metrics.avg_hr || '—'}bpm (limit ${t.hr_max || '—'}bpm).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].join(' ');
}

function buildSwimEmail(metrics, session) {
  const t = session.targets || {};
  return [
    `${session.day} swim done. ${metrics.total_distance_m || '—'}m (target ${t.total_distance_m || '—'}m),`,
    `main-set pace ${metrics.main_set_pace_sec ? formatPace100(metrics.main_set_pace_sec) : '—'}/100m`,
    `(target ${t.main_set?.css_target_sec_per_100m ? formatPace100(t.main_set.css_target_sec_per_100m) : '—'}/100m).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].join(' ');
}

function buildStrengthEmail(metrics, session, dayOfWeek) {
  const t = session.targets || {};
  const exercises = (t.exercises || [])
    .map(e => `${e.name} ${e.sets}×${e.reps || (e.distance_m + 'm')}${e.per_side ? '/side' : ''}`)
    .join(', ');
  return [
    `${dayOfWeek} ${session.type} Strength done — ${metrics.duration_min}min, ${metrics.calories}kcal.`,
    exercises ? `\nPrescribed: ${exercises}` : '',
    t.mobility_min ? ` + ${t.mobility_min}min ${t.mobility_focus || 'mobility'}.` : '.',
    `\n\nQuick check-in:`,
    `\n1. What weights did you use?`,
    `\n2. All sets and reps done, or anything cut?`,
    `\n3. Full ${t.mobility_min || '—'}min mobility or shorter?`,
    `\n4. RPE 1–10, and anything that felt off?`,
  ].join('');
}

function formatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  return `${m}:${String(secPerKm % 60).padStart(2, '0')}`;
}

function formatPace100(secPer100m) { return formatPace(secPer100m); }

module.exports = { buildEmailBody };
```

- [ ] **Step 2: Write the failing tests for analyze-workout**

```js
// tests/scripts/analyze-workout.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/fit-parser');
jest.mock('../../lib/plan');
jest.mock('../../lib/compliance');
jest.mock('../../lib/email');
jest.mock('../../lib/email-templates');

const { getSupabase } = require('../../lib/supabase');
const { extractMetrics } = require('../../lib/fit-parser');
const { loadPlan, calcPlanWeek, matchSession } = require('../../lib/plan');
const { scoreCompliance } = require('../../lib/compliance');
const { sendFeedbackEmail } = require('../../lib/email');
const { buildEmailBody } = require('../../lib/email-templates');

const mockWorkout = {
  id: 'uuid-123', garmin_activity_id: 999, sport: 'bike',
  date: '2026-03-18', day_of_week: 'Wednesday',
  fit_file_path: 'fit-files/2026-03-18_bike_999.fit', status: 'synced',
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
  storage: { from: jest.fn().mockReturnThis(), download: jest.fn().mockResolvedValue({ data: Buffer.from('fit') }) },
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  extractMetrics.mockResolvedValue({ duration_min: 60, avg_power: 175, normalized_power: 178 });
  loadPlan.mockReturnValue({ plan_start_date: '2026-03-17', athlete: { ftp: 190 }, weeks: [] });
  calcPlanWeek.mockReturnValue(1);
  matchSession.mockReturnValue(null);
  scoreCompliance.mockReturnValue({ score: null, breakdown: {} });
  sendFeedbackEmail.mockResolvedValue({ messageId: '<msg@gmail.com>' });
  buildEmailBody.mockReturnValue('Bike email body');
});

test('updates status to analyzing then awaiting_feedback', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  const calls = mockDb.update.mock.calls.map(c => c[0]);
  expect(calls.some(c => c.status === 'analyzing')).toBe(true);
  expect(calls.some(c => c.status === 'awaiting_feedback')).toBe(true);
});

test('passes plan.athlete to extractMetrics', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(extractMetrics).toHaveBeenCalledWith(
    expect.anything(),
    'bike',
    { ftp: 190 }
  );
});

test('stores email_message_id after sending', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ email_message_id: '<msg@gmail.com>' }));
});

test('tags unmatched activity as unplanned', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ plan_session_id: 'unplanned' }));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest tests/scripts/analyze-workout.test.js`
Expected: FAIL

- [ ] **Step 4: Implement scripts/analyze-workout.js**

```js
// scripts/analyze-workout.js
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { extractMetrics } = require('../lib/fit-parser');
const { loadPlan, calcPlanWeek, matchSession } = require('../lib/plan');
const { scoreCompliance } = require('../lib/compliance');
const { sendFeedbackEmail } = require('../lib/email');
const { buildEmailBody } = require('../lib/email-templates');

async function run(workoutId) {
  const db = getSupabase();

  // 1. Load
  const { data: workout } = await db.from('workouts').select('*').eq('id', workoutId).single();
  await db.from('workouts').update({ status: 'analyzing' }).eq('id', workoutId);

  const { data: fitData } = await db.storage.from('fit-files').download(workout.fit_file_path);

  // 2. Match to plan (done before extractMetrics so athlete profile is available)
  const plan = loadPlan();
  const planWeek = calcPlanWeek(plan.plan_start_date, workout.date);
  const session = matchSession(plan, planWeek, workout.day_of_week, workout.sport);
  const planSessionId = session ? session.id : 'unplanned';

  const metrics = await extractMetrics(fitData, workout.sport, plan.athlete);

  // 3. Compliance score
  const { score, compliance_breakdown } = session
    ? (() => { const r = scoreCompliance(session, metrics); return { score: r.score, compliance_breakdown: r.breakdown }; })()
    : { score: null, compliance_breakdown: null };

  // 4. Persist metrics + plan match
  await db.from('workouts').update({
    plan_week: planWeek,
    plan_session_id: planSessionId,
    compliance_score: score,
    compliance_breakdown,
    ...flattenMetrics(metrics),
  }).eq('id', workoutId);

  // 5. Send feedback email
  const subject = `[CoachCarter] ${workout.day_of_week} ${workout.sport} — feedback needed`;
  const body = buildEmailBody(workout, metrics, session);
  const { messageId } = await sendFeedbackEmail({
    to: process.env.ATHLETE_EMAIL,
    subject,
    body,
  });

  await db.from('workouts').update({
    email_message_id: messageId,
    status: 'awaiting_feedback',
  }).eq('id', workoutId);

  console.log(`[analyze-workout] ${workoutId} → ${planSessionId}, score=${score}`);
}

function flattenMetrics(metrics) {
  // All metrics fields are persisted — start_time and end_time are spec-required DB columns
  return metrics;
}

module.exports = { run };
if (require.main === module) {
  const id = process.argv[2];
  if (!id) { console.error('Usage: node scripts/analyze-workout.js <workout-id>'); process.exit(1); }
  run(id).catch(console.error);
}
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/scripts/analyze-workout.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Create skills/analyze-workout.md**

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add coachCarter/lib/email-templates.js coachCarter/scripts/analyze-workout.js coachCarter/tests/scripts/analyze-workout.test.js coachCarter/skills/analyze-workout.md
git commit -m "feat: add analyze-workout pipeline with email templates"
```

---

## Chunk 8: Coaching Reports

### Task 12: lib/coaching.js + scripts/finalize-coaching.js + skill

**Files:**
- Create: `coachCarter/lib/coaching.js`
- Create: `coachCarter/scripts/finalize-coaching.js`
- Create: `coachCarter/tests/lib/coaching.test.js`
- Create: `coachCarter/tests/scripts/finalize-coaching.test.js`
- Create: `coachCarter/skills/finalize-coaching.md`

> Note: Uses `@anthropic-ai/sdk`. Add `coachcarter-anthropic` to Keychain before running:
> ```bash
> security add-generic-password -s "coachcarter-anthropic" -a "anthropic" -w "sk-ant-..."
> ```

- [ ] **Step 1: Write failing tests for lib/coaching.js**

```js
// tests/lib/coaching.test.js
jest.mock('@anthropic-ai/sdk');
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('sk-test') }));

const Anthropic = require('@anthropic-ai/sdk');
const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Great session! Keep it up.' }],
});
Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));

const { generateCoachingReport } = require('../../lib/coaching');

test('calls Claude API with workout context and returns report text', async () => {
  const result = await generateCoachingReport({
    workout: { sport: 'bike', date: '2026-03-18', day_of_week: 'Wednesday', compliance_score: 85 },
    metrics: { normalized_power: 175, duration_min: 60 },
    session: { id: 'mon_bike', targets: {}, coaching_notes: '' },
    feedback: 'Felt strong. 8/10.',
    plan: { athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 } },
  });
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    model: expect.stringContaining('claude'),
    messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
  }));
  expect(result).toBe('Great session! Keep it up.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/lib/coaching.test.js`
Expected: FAIL

- [ ] **Step 3: Implement lib/coaching.js**

```js
// lib/coaching.js
const Anthropic = require('@anthropic-ai/sdk');
const { getSecret } = require('./keychain');

function getClient() {
  return new Anthropic({ apiKey: getSecret('coachcarter-anthropic') });
}

async function generateCoachingReport({ workout, metrics, session, feedback, plan }) {
  const client = getClient();
  const a = plan.athlete;

  const athleteCtx = `Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.`;

  const workoutCtx = `
${workout.day_of_week} ${workout.sport} — ${workout.date}
Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})
Duration: ${metrics.duration_min}min | Calories: ${metrics.calories || '—'}
${workout.sport === 'bike' ? `NP: ${metrics.normalized_power}W | VI: ${metrics.variability_index} | TSS: ${metrics.tss} | Intervals: ${metrics.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : ''}
${workout.sport === 'run'  ? `Avg pace: ${metrics.avg_pace_sec}s/km | Avg HR: ${metrics.avg_hr}bpm` : ''}
${workout.sport === 'swim' ? `Distance: ${metrics.total_distance_m}m | Main-set pace: ${metrics.main_set_pace_sec}s/100m` : ''}
Compliance: ${workout.compliance_score ?? 'TBD'}
Targets: ${JSON.stringify(session?.targets || {})}
Coaching notes: ${session?.coaching_notes || 'none'}
Athlete feedback: ${feedback || 'none'}
`.trim();

  const prompt = `You are a triathlon coach reviewing a completed workout. Write a 2–3 paragraph coaching report.

${athleteCtx}

${workoutCtx}

Be specific about what the numbers mean, acknowledge what went well, and identify what to improve. If compliance < 70, end with one concrete plan adjustment suggestion phrased as a question for the athlete to confirm.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// Extracts structured compliance from a strength session email reply
async function generateStrengthCompliance({ session, feedback }) {
  const client = getClient();
  const t = session.targets || {};
  const exercises = (t.exercises || [])
    .map(e => `${e.name}: ${e.sets}×${e.reps || e.distance_m + 'm'}${e.per_side ? '/side' : ''}`)
    .join('\n');

  const prompt = `Extract structured compliance data from this strength session reply.

Prescribed exercises:
${exercises}
Mobility: ${t.mobility_min || 0}min ${t.mobility_focus || ''}

Athlete reply:
${feedback}

Return JSON only:
{
  "exercises_completed": [{"name": "...", "sets_done": 0, "reps_done": 0, "weight_kg": 0}],
  "all_exercises_done": true,
  "mobility_done_min": 0,
  "rpe": 0,
  "compliance_score": 0
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(response.content[0].text);
}

// Generates a weekly training summary email (3–5 paragraphs)
async function generateWeeklyReport({ planWeek, weekStart, weekEnd, sessionStatuses, avgCompliance, priorWeekCompliance, plan }) {
  const client = getClient();
  const a = plan.athlete;

  const trend = priorWeekCompliance != null
    ? `Prior week compliance: ${priorWeekCompliance}% → this week: ${avgCompliance ?? 'incomplete'}`
    : 'No prior week data available for trend.';

  const sessionSummary = sessionStatuses
    .map(s => `  ${s.session}: ${s.status}${s.score != null ? ` (${s.score}%)` : ''}`)
    .join('\n');

  const prompt = `You are a triathlon coach writing a weekly training summary.

Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.

Week ${planWeek} (${weekStart} – ${weekEnd}):
${sessionSummary}
Overall compliance: ${avgCompliance ?? 'N/A'}%
${trend}

Write a 3–5 paragraph coaching summary covering:
1. What went well this week
2. What was missed and its likely impact
3. One specific plan.json adjustment if compliance was low (phrased as a question for the athlete to confirm)
4. Focus for next week`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

module.exports = { generateCoachingReport, generateStrengthCompliance, generateWeeklyReport };
```

- [ ] **Step 4: Run test**

Run: `npx jest tests/lib/coaching.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Write failing tests for scripts/finalize-coaching.js**

```js
// tests/scripts/finalize-coaching.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/compliance');
jest.mock('../../lib/coaching');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, matchSession } = require('../../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../../lib/coaching');

const mockWorkout = {
  id: 'uuid-456', sport: 'bike', date: '2026-03-18',
  day_of_week: 'Wednesday', plan_week: 1, plan_session_id: 'wed_bike',
  feedback: 'Great. 8/10.', compliance_score: 80,
  normalized_power: 175, duration_min: 58,
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({ athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 }, weeks: [] });
  matchSession.mockReturnValue({ id: 'wed_bike', type: 'intervals', targets: {}, coaching_notes: '' });
  generateCoachingReport.mockResolvedValue('Solid session this week...');
  generateStrengthCompliance.mockResolvedValue({ compliance_score: 85 });
});

test('generates coaching report and saves it with status = complete', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateCoachingReport).toHaveBeenCalledWith(expect.objectContaining({
    workout: expect.objectContaining({ id: 'uuid-456' }),
    feedback: 'Great. 8/10.',
    plan: expect.objectContaining({ athlete: expect.objectContaining({ ftp: 190 }) }),
  }));
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({
    coaching_report: 'Solid session this week...',
    status: 'complete',
  }));
});

test('for strength: calls generateStrengthCompliance to compute score from reply', async () => {
  mockDb.single.mockResolvedValue({ data: { ...mockWorkout, sport: 'strength', compliance_score: null } });
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateStrengthCompliance).toHaveBeenCalledWith(expect.objectContaining({
    session: expect.objectContaining({ id: 'wed_bike' }),
    feedback: 'Great. 8/10.',
  }));
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest tests/scripts/finalize-coaching.test.js`
Expected: FAIL

- [ ] **Step 7: Implement scripts/finalize-coaching.js**

```js
// scripts/finalize-coaching.js
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { loadPlan, matchSession } = require('../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../lib/coaching');

async function run(workoutId) {
  const db = getSupabase();
  const { data: workout } = await db.from('workouts').select('*').eq('id', workoutId).single();

  const plan = loadPlan();
  const session = matchSession(plan, workout.plan_week, workout.day_of_week, workout.sport);

  let complianceScore = workout.compliance_score;
  let complianceBreakdown = workout.compliance_breakdown;

  // Strength: score from email reply via Claude
  if (workout.sport === 'strength') {
    if (!session) {
      console.warn(`[finalize-coaching] No plan session found for ${workoutId} — cannot score strength compliance`);
    } else {
      const result = await generateStrengthCompliance({ session, feedback: workout.feedback });
      complianceScore = result.compliance_score;
      complianceBreakdown = result;
    }
  }

  // Claude pass 2: coaching report
  const coachingReport = await generateCoachingReport({
    workout: { ...workout, compliance_score: complianceScore },
    metrics: workout,
    session,
    feedback: workout.feedback,
    plan,
  });

  await db.from('workouts').update({
    compliance_score: complianceScore,
    compliance_breakdown: complianceBreakdown,
    coaching_report: coachingReport,
    status: 'complete',
  }).eq('id', workoutId);

  console.log(`[finalize-coaching] ${workoutId} complete, score=${complianceScore}`);

  if (complianceScore != null && complianceScore < 70) {
    console.log('[finalize-coaching] Compliance < 70 — report includes plan adjustment suggestion');
  }
}

module.exports = { run };
if (require.main === module) {
  const id = process.argv[2];
  if (!id) { console.error('Usage: node scripts/finalize-coaching.js <workout-id>'); process.exit(1); }
  run(id).catch(console.error);
}
```

- [ ] **Step 8: Run all finalize tests**

Run: `npx jest tests/scripts/finalize-coaching.test.js`
Expected: PASS (2 tests)

- [ ] **Step 9: Create skills/finalize-coaching.md**

```markdown
---
name: finalize-coaching
description: Combine FIT metrics + athlete email reply to produce a coaching report
trigger: run after IMAP polling detects a reply
---

# /finalize-coaching {id}

Runs after an athlete reply has been stored on a workout row. Calls Claude to generate a coaching report and — for strength sessions — computes compliance from the reply text.

## Steps

1. Poll the CoachCarter inbox for new replies:
   ```bash
   cd coachCarter && node -e "
     require('dotenv').config();
     const { pollReplies } = require('./lib/email');
     const { getSupabase } = require('./lib/supabase');
     const db = getSupabase();
     pollReplies({ onReply: async ({ inReplyTo, body }) => {
       const { data } = await db.from('workouts').select('id').eq('email_message_id', inReplyTo).single();
       if (data) {
         await db.from('workouts').update({ feedback: body, feedback_received_at: new Date().toISOString() }).eq('id', data.id);
         console.log('Reply stored for workout:', data.id);
       }
     }});
   "
   ```

2. For each workout ID where feedback was just stored:
   ```bash
   node scripts/finalize-coaching.js {id}
   ```

3. Report: compliance_score and the first 2 lines of coaching_report.

4. If compliance < 70: the report ends with a plan adjustment suggestion. Confirm with the athlete before running /update-plan.
```

- [ ] **Step 10: Commit**

```bash
git add coachCarter/lib/coaching.js coachCarter/tests/lib/coaching.test.js coachCarter/scripts/finalize-coaching.js coachCarter/tests/scripts/finalize-coaching.test.js coachCarter/skills/finalize-coaching.md
git commit -m "feat: add coaching module and finalize-coaching pipeline"
```

---

## Chunk 9: Weekly Review & Remaining Skills

### Task 13: scripts/weekly-review.js + skill

**Files:**
- Create: `coachCarter/scripts/weekly-review.js`
- Create: `coachCarter/tests/scripts/weekly-review.test.js`
- Create: `coachCarter/skills/weekly-review.md`

- [ ] **Step 1: Write the failing tests**

```js
// tests/scripts/weekly-review.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/coaching');
jest.mock('../../lib/email');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, calcPlanWeek } = require('../../lib/plan');
const { generateWeeklyReport } = require('../../lib/coaching');
const { sendFeedbackEmail } = require('../../lib/email');

const mockInsert = jest.fn().mockResolvedValue({ error: null });
const mockDb = {
  from: jest.fn().mockImplementation((table) => {
    if (table === 'weekly_summaries') return {
      insert: mockInsert,
      select: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [{ overall_compliance: 78 }] }),
    };
    return {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockResolvedValue({ data: [] }),
    };
  }),
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({
    plan_start_date: '2026-03-17',
    athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 },
    weeks: [{ week: 1, sessions: [{ id: 'mon_bike', day: 'Monday', sport: 'bike' }] }],
  });
  calcPlanWeek.mockReturnValue(1);
  generateWeeklyReport.mockResolvedValue('Good week overall.');
  sendFeedbackEmail.mockResolvedValue({ messageId: '<weekly@gmail.com>' });
});

test('queries workouts table for the current week', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('workouts');
});

test('sends weekly email and inserts into weekly_summaries', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(sendFeedbackEmail).toHaveBeenCalledWith(expect.objectContaining({
    subject: expect.stringContaining('Week 1 Review'),
    body: 'Good week overall.',
  }));
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
    plan_week: 1,
  }));
});

test('passes prior week compliance trend to generateWeeklyReport', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(generateWeeklyReport).toHaveBeenCalledWith(
    expect.objectContaining({ priorWeekCompliance: 78 })
  );
});

test('passes priorWeekCompliance: null when no prior week data exists', async () => {
  mockDb.from.mockImplementation((table) => {
    if (table === 'weekly_summaries') return {
      insert: mockInsert,
      select: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [] }),
    };
    return {
      select: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    };
  });
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(generateWeeklyReport).toHaveBeenCalledWith(
    expect.objectContaining({ priorWeekCompliance: null })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/scripts/weekly-review.test.js`
Expected: FAIL

- [ ] **Step 3: Implement scripts/weekly-review.js**

```js
// scripts/weekly-review.js
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { loadPlan, calcPlanWeek, matchSession } = require('../lib/plan');
const { generateWeeklyReport } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');

async function run() {
  const db = getSupabase();
  const plan = loadPlan();

  // Calculate Mon–Sun date range for current week
  const today = new Date();
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today); monday.setDate(today.getDate() + mondayOffset);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const weekStart = monday.toISOString().split('T')[0];
  const weekEnd = sunday.toISOString().split('T')[0];

  const planWeek = calcPlanWeek(plan.plan_start_date, weekStart);

  const { data: workouts } = await db.from('workouts').select('*')
    .gte('date', weekStart).lte('date', weekEnd);

  const weekPlan = plan.weeks.find(w => w.week === planWeek);
  const plannedSessions = weekPlan?.sessions || [];

  let completed = 0, missed = 0;
  const sessionStatuses = [];

  for (const session of plannedSessions) {
    const match = (workouts || []).find(w => w.plan_session_id === session.id);
    if (!match) {
      missed++;
      sessionStatuses.push({ session: session.id, status: 'missed' });
    } else if (match.status === 'complete') {
      completed++;
      sessionStatuses.push({ session: session.id, status: 'complete', score: match.compliance_score });
    } else {
      sessionStatuses.push({ session: session.id, status: 'pending' });
    }
  }

  const completedWorkouts = (workouts || []).filter(w => w.status === 'complete');
  const avgCompliance = completedWorkouts.length
    ? Math.round(completedWorkouts.reduce((s, w) => s + (w.compliance_score || 0), 0) / completedWorkouts.length)
    : null;

  // Fetch prior week compliance for trend
  const { data: priorWeeks } = await db.from('weekly_summaries')
    .select('overall_compliance').lt('week_end_date', weekStart)
    .order('week_end_date', { ascending: false }).limit(1);
  const priorWeekCompliance = priorWeeks?.[0]?.overall_compliance ?? null;

  const summary = await generateWeeklyReport({
    planWeek,
    weekStart,
    weekEnd,
    sessionStatuses,
    avgCompliance,
    priorWeekCompliance,
    plan,
  });

  await sendFeedbackEmail({
    to: process.env.ATHLETE_EMAIL,
    subject: `[CoachCarter] Week ${planWeek} Review — ${weekStart}`,
    body: summary,
  });

  await db.from('weekly_summaries').insert({
    plan_week: planWeek,
    week_start_date: weekStart,
    week_end_date: weekEnd,
    overall_compliance: avgCompliance,
    sessions_completed: completed,
    sessions_missed: missed,
    summary,
  });

  console.log(`[weekly-review] Week ${planWeek}: ${completed} done, ${missed} missed, avg compliance ${avgCompliance}`);
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/scripts/weekly-review.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Create skills/weekly-review.md**

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add coachCarter/scripts/weekly-review.js coachCarter/tests/scripts/weekly-review.test.js coachCarter/skills/weekly-review.md
git commit -m "feat: add weekly-review script and skill"
```

---

### Task 14: scripts/update-plan.js + skill

**Files:**
- Create: `coachCarter/scripts/update-plan.js`
- Create: `coachCarter/tests/scripts/update-plan.test.js`
- Create: `coachCarter/skills/update-plan.md`

- [ ] **Step 1: Write the failing tests**

```js
// tests/scripts/update-plan.test.js
const { validatePlan } = require('../../scripts/update-plan');

test('valid plan returns no errors', () => {
  const plan = {
    plan_start_date: '2026-03-17',
    athlete: { ftp: 190 },
    weeks: [{ week: 1, sessions: [{ id: 'mon_bike', day: 'Monday', sport: 'bike' }] }],
  };
  expect(validatePlan(plan)).toHaveLength(0);
});

test('missing plan_start_date returns an error', () => {
  expect(validatePlan({ athlete: { ftp: 190 }, weeks: [] })).toContain('plan_start_date is required');
});

test('missing ftp returns an error', () => {
  expect(validatePlan({ plan_start_date: '2026-03-17', athlete: {}, weeks: [] })).toContain('athlete.ftp is required');
});

test('session missing id returns an error', () => {
  const plan = {
    plan_start_date: '2026-03-17', athlete: { ftp: 190 },
    weeks: [{ week: 1, sessions: [{ day: 'Monday', sport: 'bike' }] }],
  };
  expect(validatePlan(plan)).toContain('session.id is required');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/scripts/update-plan.test.js`
Expected: FAIL

- [ ] **Step 3: Implement scripts/update-plan.js**

```js
// scripts/update-plan.js
const { loadPlan } = require('../lib/plan');

function validatePlan(plan) {
  const errors = [];
  if (!plan.plan_start_date) errors.push('plan_start_date is required');
  if (!plan.athlete?.ftp) errors.push('athlete.ftp is required');
  if (!Array.isArray(plan.weeks)) errors.push('weeks must be an array');
  for (const week of plan.weeks || []) {
    if (!week.week || week.week < 1 || week.week > 4)
      errors.push(`week.week must be 1–4, got ${week.week}`);
    for (const session of week.sessions || []) {
      if (!session.id) errors.push('session.id is required');
      if (!session.day) errors.push('session.day is required');
      if (!session.sport) errors.push('session.sport is required');
    }
  }
  return errors;
}

function run() {
  const plan = loadPlan();
  const errors = validatePlan(plan);
  if (errors.length) {
    console.error('[update-plan] Validation errors:\n' + errors.map(e => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  console.log('[update-plan] plan.json is valid ✓');
  console.log(`  Plan: ${plan.plan_name}`);
  console.log(`  Start: ${plan.plan_start_date}`);
  console.log(`  Weeks defined: ${plan.weeks.map(w => w.week).join(', ') || '(none)'}`);
}

module.exports = { validatePlan };
if (require.main === module) run();
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/scripts/update-plan.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Create skills/update-plan.md**

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add coachCarter/scripts/update-plan.js coachCarter/tests/scripts/update-plan.test.js coachCarter/skills/update-plan.md
git commit -m "feat: add update-plan validator and skill"
```

---

## Chunk 10: Cron, Wiring & Smoke Test

### Task 15: Configure cron jobs

- [ ] **Step 1: Configure /sync-garmin cron (every 4 hours)**

In Claude Code, run:
```
/cron-create "0 */4 * * *" "cd /Users/nayan/Projects/coachCarter && node scripts/sync-garmin.js"
```

- [ ] **Step 2: Configure /weekly-review cron (Sunday 20:00)**

```
/cron-create "0 20 * * 0" "cd /Users/nayan/Projects/coachCarter && node scripts/weekly-review.js"
```

- [ ] **Step 3: Configure IMAP reply polling (every 15 minutes)**

```
/cron-create "*/15 * * * *" "cd /Users/nayan/Projects/coachCarter && node -e \"require('dotenv').config(); const {pollReplies}=require('./lib/email'); const {getSupabase}=require('./lib/supabase'); const {run}=require('./scripts/finalize-coaching'); pollReplies({onReply: async ({inReplyTo, body}) => { const db=getSupabase(); const {data}=await db.from('workouts').select('id').eq('email_message_id',inReplyTo).single(); if(data){await db.from('workouts').update({feedback:body,feedback_received_at:new Date().toISOString()}).eq('id',data.id); await run(data.id);} }});\""
```

- [ ] **Step 4: Verify crons are registered**

Run `/cron-list` in Claude Code to confirm all three cron jobs appear with the correct schedules.

---

### Task 16: Add secrets, fill env, and smoke test

- [ ] **Step 1: Add all Keychain secrets**

```bash
security add-generic-password -s "coachcarter-garmin"    -a "$GARMIN_EMAIL"        -w "your-garmin-password"
security add-generic-password -s "coachcarter-gmail"     -a "$COACHCARTER_EMAIL"   -w "your-16-char-app-password"
security add-generic-password -s "coachcarter-supabase"  -a "supabase"             -w "your-service-key"
security add-generic-password -s "coachcarter-anthropic" -a "anthropic"            -w "sk-ant-..."
```

- [ ] **Step 2: Fill in .env**

```bash
cp coachCarter/.env.example coachCarter/.env
# Edit .env: fill in SUPABASE_URL, GARMIN_EMAIL, COACHCARTER_EMAIL, ATHLETE_EMAIL
```

- [ ] **Step 3: Run the full test suite**

Run: `cd coachCarter && npx jest --verbose`
Expected: All tests PASS. No test should touch the real network or Keychain.

- [ ] **Step 4: Populate plan.json week 1**

Read `offseason_training_plan.xlsx` → "Workout Library" sheet. Populate the `weeks` array in `plan.json` with week 1 sessions following the schema in the spec. Run the validator:

```bash
cd coachCarter && node scripts/update-plan.js
```

Expected: `plan.json is valid ✓`, `Weeks defined: 1`

Commit:
```bash
git add coachCarter/plan.json
git commit -m "plan: populate week 1 sessions from offseason training plan"
```

- [ ] **Step 5: Manual smoke test — sync one activity**

```bash
cd coachCarter && node scripts/sync-garmin.js
```

Expected: logs show activity IDs found, FIT files uploaded, workout rows inserted.

Then for each workout ID logged, manually run:
```bash
node scripts/analyze-workout.js <workout-id>
```

Expected: compliance score logged, feedback email sent to ATHLETE_EMAIL.

- [ ] **Step 6: Final commit**

```bash
# Stage only tracked source files — never .env
git add coachCarter/lib coachCarter/scripts coachCarter/skills coachCarter/tests coachCarter/supabase-setup.sql coachCarter/jest.config.js coachCarter/package.json coachCarter/package-lock.json coachCarter/.gitignore coachCarter/.env.example coachCarter/plan.json
git commit -m "chore: coachcarter implementation complete — all systems wired and tested"
```
