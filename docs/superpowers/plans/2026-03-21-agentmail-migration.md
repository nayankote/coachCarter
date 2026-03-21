# AgentMail Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmail SMTP + IMAP polling with AgentMail HTTP API + Supabase Edge Function webhook receiver, and fix the existing gap where finalize-coaching never emailed the final coaching report.

**Architecture:** `sendFeedbackEmail` in `lib/email.js` is re-implemented to POST to the AgentMail API instead of SMTP. A new Supabase Deno Edge Function (`on-reply`) receives AgentMail webhooks, runs finalize-coaching logic inline, and sends the final coaching report back to the athlete. `finalize-coaching.js` is also updated to send the email for manual retries.

**Tech Stack:** Node.js (existing scripts), Deno (Supabase Edge Functions), AgentMail HTTP API, Anthropic API (raw fetch in Deno), Supabase JS client, Jest

---

## Chunk 1: Data and config groundwork

### Task 1: Store session_data in workouts table

The Edge Function needs the athlete profile (FTP, LTHR, etc.) and session targets to build the same coaching prompt as `lib/coaching.js`. These live in `plan.json`, not the workout row. Fix: store them at analysis time.

**Files:**
- Modify: `scripts/analyze-workout.js:34-40` (add session_data to the update)
- SQL: run in Supabase SQL editor (one-time)

- [ ] **Step 1: Add session_data column in Supabase**

Run in the Supabase SQL editor:
```sql
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS session_data jsonb;
```

- [ ] **Step 2: Update analyze-workout.js to store session_data**

In `scripts/analyze-workout.js`, change the persistence update (around line 34) from:
```js
await db.from('workouts').update({
  plan_week: planWeek,
  plan_session_id: planSessionId,
  compliance_score: score,
  compliance_breakdown,
  ...flattenMetrics(metrics),
}).eq('id', workoutId);
```
to:
```js
await db.from('workouts').update({
  plan_week: planWeek,
  plan_session_id: planSessionId,
  compliance_score: score,
  compliance_breakdown,
  session_data: { session: session || null, athlete: plan.athlete },
  ...flattenMetrics(metrics),
}).eq('id', workoutId);
```

- [ ] **Step 3: Verify the test still passes**

Run: `npx jest tests/scripts/analyze-workout.test.js --no-coverage`
Expected: PASS (test mocks db.update so no change needed)

- [ ] **Step 4: Commit**

```bash
git add scripts/analyze-workout.js
git commit -m "feat: store session_data in workout row for Edge Function context"
```

---

### Task 2: Add AgentMail config

**Files:**
- Modify: `lib/keychain.js:5-10`
- Modify: `.env`

- [ ] **Step 1: Add AGENTMAIL_API_KEY to keychain.js ENV_VAR_MAP**

In `lib/keychain.js`, add to `ENV_VAR_MAP`:
```js
const ENV_VAR_MAP = {
  'coachcarter-anthropic': 'ANTHROPIC_API_KEY',
  'coachcarter-garmin':    'GARMIN_PASSWORD',
  'coachcarter-gmail':     'GMAIL_APP_PASSWORD',
  'coachcarter-supabase':  'SUPABASE_SERVICE_KEY',
  'coachcarter-agentmail': 'AGENTMAIL_API_KEY',   // ← add this line
};
```

- [ ] **Step 2: Add AGENTMAIL_INBOX to .env**

Add to `.env`:
```
AGENTMAIL_INBOX=coachcarter
```

Also add a keychain comment at the bottom of `.env`:
```
# security add-generic-password -s "coachcarter-agentmail" -a "agentmail" -w "your-agentmail-api-key"
```

- [ ] **Step 3: Commit**

```bash
git add lib/keychain.js .env
git commit -m "config: add AgentMail API key mapping and inbox env var"
```

---

## Chunk 2: lib/email.js and finalize-coaching.js

### Task 3: Rewrite sendFeedbackEmail to use AgentMail

**Files:**
- Replace: `tests/lib/email.test.js` (existing file has Gmail/nodemailer tests — intentionally deleted, that behavior is being removed)
- Modify: `lib/email.js`

- [ ] **Step 1: Replace the test file with AgentMail tests**

Note: `tests/lib/email.test.js` already exists with Gmail tests. Replace its entire contents — those tests cover nodemailer behavior that no longer exists after this task.

Write `tests/lib/email.test.js`:
```js
// tests/lib/email.test.js
jest.mock('../../lib/keychain', () => ({ getSecret: () => 'test-agentmail-key' }));

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  jest.resetModules();
  mockFetch.mockReset();
  process.env.AGENTMAIL_INBOX = 'coachcarter';
});

test('sends email via AgentMail API', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message_id: '<abc123@mail.agentmail.to>' }),
  });

  const { sendFeedbackEmail } = require('../../lib/email');
  const result = await sendFeedbackEmail({
    to: 'athlete@example.com',
    subject: 'Test subject',
    body: 'Test body',
  });

  expect(mockFetch).toHaveBeenCalledWith(
    'https://api.agentmail.to/v0/inboxes/coachcarter/messages',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-agentmail-key' }),
    })
  );
  expect(result.messageId).toBe('<abc123@mail.agentmail.to>');
});

test('includes reply_to_message_id when threading', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message_id: '<reply@mail.agentmail.to>' }),
  });

  const { sendFeedbackEmail } = require('../../lib/email');
  await sendFeedbackEmail({
    to: 'athlete@example.com',
    subject: 'Re: test',
    body: 'Report body',
    replyToMessageId: '<original@mail.agentmail.to>',
  });

  const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(sentBody.reply_to_message_id).toBe('<original@mail.agentmail.to>');
});

test('throws on AgentMail API error', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

  const { sendFeedbackEmail } = require('../../lib/email');
  await expect(
    sendFeedbackEmail({ to: 'x', subject: 'x', body: 'x' })
  ).rejects.toThrow('AgentMail send failed (401)');
});
```

- [ ] **Step 2: Run the new tests — verify they fail**

Run: `npx jest tests/lib/email.test.js --no-coverage`
Expected: FAIL — `sendFeedbackEmail` still uses nodemailer, not the AgentMail fetch

- [ ] **Step 3: Rewrite lib/email.js**

Replace the entire contents of `lib/email.js` with:
```js
// lib/email.js
const { getSecret } = require('./keychain');

async function sendFeedbackEmail({ to, subject, body, replyToMessageId = null }) {
  const apiKey = getSecret('coachcarter-agentmail');
  const inbox = process.env.AGENTMAIL_INBOX;

  const payload = {
    to,
    subject,
    text: body,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
  };

  // IMPORTANT: verify at setup that AgentMail returns RFC 2822 message_id
  // (e.g. <abc@mail.agentmail.to>) not an internal UUID — this value gets
  // stored in workouts.email_message_id and matched against In-Reply-To headers
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${inbox}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentMail send failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return { messageId: data.message_id };
}

// pollReplies: deprecated — replaced by AgentMail webhook → on-reply Edge Function
// Left here to avoid breaking imports during migration. Remove after verification.
async function pollReplies() {
  console.warn('[email] pollReplies is deprecated — replies are now handled by the on-reply Edge Function');
  return 0;
}

module.exports = { sendFeedbackEmail, pollReplies };
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx jest tests/lib/email.test.js --no-coverage`
Expected: PASS (3 tests)

- [ ] **Step 5: Run partial regression check**

Run: `npx jest tests/scripts/analyze-workout.test.js tests/lib/fit-parser.test.js --no-coverage`
Expected: PASS

Note: do NOT run the full suite yet — `tests/scripts/finalize-coaching.test.js` still has the old version which does not mock `lib/email` and will fail now that `lib/email.js` calls AgentMail. That file is replaced in Task 4 Step 1.

- [ ] **Step 6: Commit**

```bash
git add lib/email.js tests/lib/email.test.js
git commit -m "feat: replace nodemailer with AgentMail HTTP API in sendFeedbackEmail"
```

---

### Task 4: Fix finalize-coaching.js to send final coaching report

This fixes the existing gap where the coaching report was stored in Supabase but never emailed to the athlete.

**Files:**
- Replace: `tests/scripts/finalize-coaching.test.js`
- Modify: `scripts/finalize-coaching.js`

- [ ] **Step 1: Replace the test file**

Note: `tests/scripts/finalize-coaching.test.js` already exists with 2 tests that do NOT mock `lib/email`. Those tests break after Task 3's email rewrite. Replace the entire file with the 4 tests below — they cover all original assertions plus the new email-sending behavior.

Replace `tests/scripts/finalize-coaching.test.js`:
```js
// tests/scripts/finalize-coaching.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/coaching');
jest.mock('../../lib/email');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, matchSession } = require('../../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../../lib/coaching');
const { sendFeedbackEmail } = require('../../lib/email');

const mockWorkout = {
  id: 'uuid-456',
  sport: 'bike',
  day_of_week: 'Wednesday',
  plan_week: 1,
  compliance_score: 85,
  compliance_breakdown: {},
  email_message_id: '<original@mail.agentmail.to>',
  feedback: 'Felt great, hit all intervals',
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
};

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.ATHLETE_EMAIL = 'athlete@example.com';
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({ plan_start_date: '2026-03-17', athlete: { ftp: 190 }, weeks: [] });
  matchSession.mockReturnValue(null);
  generateCoachingReport.mockResolvedValue('Great ride. Threshold power was spot on...');
  sendFeedbackEmail.mockResolvedValue({ messageId: '<report@mail.agentmail.to>' });
});

test('sends final coaching report email to athlete', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(sendFeedbackEmail).toHaveBeenCalledWith(
    expect.objectContaining({ body: 'Great ride. Threshold power was spot on...' })
  );
});

test('threads final report as reply to original coaching email', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(sendFeedbackEmail).toHaveBeenCalledWith(
    expect.objectContaining({ replyToMessageId: '<original@mail.agentmail.to>' })
  );
});

test('marks workout complete after sending report', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(mockDb.update).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'complete' })
  );
});

test('extracts strength compliance from reply for strength workouts', async () => {
  mockDb.single.mockResolvedValue({ data: { ...mockWorkout, sport: 'strength' } });
  generateStrengthCompliance.mockResolvedValue({ compliance_score: 90, exercises_completed: [] });

  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateStrengthCompliance).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx jest tests/scripts/finalize-coaching.test.js --no-coverage`
Expected: FAIL — `sendFeedbackEmail` is never called

- [ ] **Step 3: Update finalize-coaching.js to send the email**

In `scripts/finalize-coaching.js`, add the require at the top and the email send after coaching report generation:

```js
// scripts/finalize-coaching.js
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { loadPlan, matchSession } = require('../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');   // ← add this

async function run(workoutId) {
  const db = getSupabase();
  const { data: workout } = await db.from('workouts').select('*').eq('id', workoutId).single();

  const plan = loadPlan();
  const session = matchSession(plan, workout.plan_week, workout.day_of_week, workout.sport);

  let complianceScore = workout.compliance_score;
  let complianceBreakdown = workout.compliance_breakdown;

  if (workout.sport === 'strength') {
    if (!session) {
      console.warn(`[finalize-coaching] No plan session found for ${workoutId} — cannot score strength compliance`);
    } else {
      const result = await generateStrengthCompliance({ session, feedback: workout.feedback });
      complianceScore = result.compliance_score;
      complianceBreakdown = result;
    }
  }

  const coachingReport = await generateCoachingReport({
    workout: { ...workout, compliance_score: complianceScore },
    metrics: workout,
    session,
    feedback: workout.feedback,
    plan,
  });

  // Send final coaching report to athlete (fixes gap: previously only stored, never emailed)
  await sendFeedbackEmail({
    to: process.env.ATHLETE_EMAIL,
    subject: `[CoachCarter] ${workout.day_of_week} ${workout.sport} — coaching report`,
    body: coachingReport,
    replyToMessageId: workout.email_message_id,
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

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx jest tests/scripts/finalize-coaching.test.js --no-coverage`
Expected: PASS (4 tests)

- [ ] **Step 5: Run full test suite**

Run: `npx jest --no-coverage`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add scripts/finalize-coaching.js tests/scripts/finalize-coaching.test.js
git commit -m "fix: send final coaching report email in finalize-coaching"
```

---

## Chunk 3: Supabase Edge Function

### Task 5: Build on-reply Edge Function

**Files:**
- Create: `supabase/functions/on-reply/index.ts`

No unit tests for the Edge Function (Deno runtime — separate test setup not worth it for a personal tool). Verified by end-to-end test in Task 6.

- [ ] **Step 1: Create the Edge Function file**

Create `supabase/functions/on-reply/index.ts`:
```typescript
// supabase/functions/on-reply/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Webhook signature verification
  // IMPORTANT: verify exact header name + scheme against AgentMail docs at setup (Task 6 Step 4)
  // If AgentMail uses HMAC-SHA256, simple === comparison will always fail — replace with
  // a crypto.subtle HMAC verify. If it uses plain token comparison, === is correct.
  const webhookSecret = Deno.env.get('AGENTMAIL_WEBHOOK_SECRET');
  if (webhookSecret) {
    const signature = req.headers.get('x-agentmail-signature') ?? req.headers.get('x-webhook-secret');
    if (signature !== webhookSecret) {
      console.error('[on-reply] Invalid webhook signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const payload = await req.json();

  // IMPORTANT: verify exact field names against AgentMail webhook docs at setup
  // in_reply_to may be nested under payload.headers['in-reply-to'] instead
  const inReplyTo = payload.in_reply_to ?? payload.headers?.['in-reply-to'];
  const replyBody = payload.text ?? stripHtml(payload.html ?? '');

  if (!inReplyTo || !replyBody) {
    console.log('[on-reply] Missing in_reply_to or body — ignoring');
    return new Response('OK', { status: 200 });
  }

  // Find workout by the message ID of the original coaching email
  const { data: workout } = await supabase
    .from('workouts')
    .select('*')
    .eq('email_message_id', inReplyTo)
    .single();

  if (!workout) {
    console.log(`[on-reply] No workout found for in_reply_to=${inReplyTo}`);
    return new Response('OK', { status: 200 });
  }

  // Atomic status transition — prevents double-fire from webhook retries
  const { data: locked } = await supabase
    .from('workouts')
    .update({ status: 'processing' })
    .eq('id', workout.id)
    .eq('status', 'awaiting_feedback')
    .select()
    .single();

  if (!locked) {
    console.log(`[on-reply] Workout ${workout.id} already processing or complete — skipping`);
    return new Response('OK', { status: 200 });
  }

  try {
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!;
    const agentmailKey = Deno.env.get('AGENTMAIL_API_KEY')!;
    const agentmailInbox = Deno.env.get('AGENTMAIL_INBOX')!;
    const athleteEmail = Deno.env.get('ATHLETE_EMAIL')!;

    // session_data was stored by analyze-workout — contains session targets + athlete profile
    const sessionData = workout.session_data ?? {};
    const session = sessionData.session ?? null;
    const athlete = sessionData.athlete ?? {};

    let complianceScore = workout.compliance_score;
    let complianceBreakdown = workout.compliance_breakdown;

    // Strength: extract structured compliance from reply text
    if (workout.sport === 'strength' && session) {
      const prompt = buildStrengthPrompt(session, replyBody);
      const raw = await callAnthropic(anthropicKey, prompt, 400);
      const parsed = JSON.parse(raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());
      complianceScore = parsed.compliance_score;
      complianceBreakdown = parsed;
    }

    // Generate coaching report
    const coachingReport = await callAnthropic(
      anthropicKey,
      buildCoachingPrompt(workout, athlete, session, replyBody, complianceScore),
      600
    );

    // Send final coaching report threaded as reply
    await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `[CoachCarter] ${workout.day_of_week} ${workout.sport} — coaching report`,
      text: coachingReport,
      replyToMessageId: inReplyTo,
    });

    // Mark complete
    await supabase.from('workouts').update({
      status: 'complete',
      feedback: replyBody,
      compliance_score: complianceScore,
      compliance_breakdown: complianceBreakdown,
      coaching_report: coachingReport,
    }).eq('id', workout.id);

    console.log(`[on-reply] ${workout.id} complete, score=${complianceScore}`);
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('[on-reply] Error:', err);
    // Reset status so next AgentMail retry can proceed (step 2 guard checks for awaiting_feedback)
    await supabase.from('workouts').update({ status: 'awaiting_feedback' }).eq('id', workout.id);
    return new Response('Internal error', { status: 500 });
  }
});

async function callAnthropic(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

async function sendViaAgentMail(
  apiKey: string,
  inbox: string,
  { to, subject, text, replyToMessageId }: { to: string; subject: string; text: string; replyToMessageId?: string }
) {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${inbox}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to, subject, text,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AgentMail error ${res.status}: ${await res.text()}`);
}

function buildStrengthPrompt(session: any, feedback: string): string {
  const exercises = (session.targets?.exercises ?? [])
    .map((e: any) => `${e.name}: ${e.sets}×${e.reps || e.distance_m + 'm'}${e.per_side ? '/side' : ''}`)
    .join('\n');
  return `Extract structured compliance data from this strength session reply.

Prescribed exercises:
${exercises}
Mobility: ${session.targets?.mobility_min ?? 0}min ${session.targets?.mobility_focus ?? ''}

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
}

function buildCoachingPrompt(
  workout: any,
  athlete: any,
  session: any,
  feedback: string,
  complianceScore: number | null
): string {
  const athleteCtx = `Athlete: FTP ${athlete.ftp ?? '?'}W, LTHR ${athlete.lthr ?? '?'}bpm, run threshold ${athlete.run_threshold_sec_per_km ?? '?'}s/km, swim CSS ${athlete.swim_css_sec_per_100m ?? '?'}s/100m.`;
  const workoutCtx = [
    `${workout.day_of_week} ${workout.sport} — ${workout.date}`,
    `Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})`,
    `Duration: ${workout.duration_min}min | Calories: ${workout.calories ?? '—'}`,
    workout.sport === 'bike' ? `NP: ${workout.normalized_power}W | VI: ${workout.variability_index} | TSS: ${workout.tss} | Intervals: ${workout.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : '',
    workout.sport === 'run' ? `Avg pace: ${workout.avg_pace_sec}s/km | Avg HR: ${workout.avg_hr}bpm` : '',
    workout.sport === 'swim' ? `Distance: ${workout.total_distance_m}m | Main-set pace: ${workout.main_set_pace_sec}s/100m` : '',
    `Compliance: ${complianceScore ?? 'N/A'}`,
    `Targets: ${JSON.stringify(session?.targets ?? {})}`,
    `Coaching notes: ${session?.coaching_notes ?? 'none'}`,
    `Athlete feedback: ${feedback}`,
  ].filter(Boolean).join('\n');

  return `You are a triathlon coach reviewing a completed workout. Write a 2–3 paragraph coaching report.

${athleteCtx}

${workoutCtx}

Be specific about what the numbers mean, acknowledge what went well, and identify what to improve.${complianceScore != null && complianceScore < 70 ? ' End with one concrete plan adjustment suggestion phrased as a question for the athlete to confirm.' : ''}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 2: Commit the Edge Function**

```bash
git add supabase/functions/on-reply/index.ts
git commit -m "feat: add on-reply Supabase Edge Function for AgentMail webhook"
```

- [ ] **Step 3: Deploy the Edge Function**

Run: `npx supabase functions deploy on-reply --project-ref xhbamjjhzogrdkfymigk`
Expected: `Deployed on-reply` with a URL like `https://xhbamjjhzogrdkfymigk.supabase.co/functions/v1/on-reply`

If not logged in: `npx supabase login` first.

- [ ] **Step 4: Set Edge Function secrets in Supabase**

```bash
npx supabase secrets set \
  ANTHROPIC_API_KEY=<your-anthropic-key> \
  AGENTMAIL_API_KEY=<your-agentmail-key> \
  AGENTMAIL_INBOX=coachcarter \
  ATHLETE_EMAIL=nayankt76@gmail.com \
  SUPABASE_SERVICE_ROLE_KEY=<your-supabase-service-role-key> \
  --project-ref xhbamjjhzogrdkfymigk
```

---

## Chunk 4: AgentMail setup and end-to-end verification

### Task 6: Set up AgentMail account and configure webhook

Manual one-time steps — no code.

- [ ] **Step 1: Create AgentMail account**

Go to agentmail.to, sign up.

- [ ] **Step 2: Create inbox**

Create inbox with username `coachcarter` → emails go to `coachcarter@agentmail.to`.

- [ ] **Step 3: Verify AgentMail API response format**

Before writing a single real email, send a test email via the API and inspect the response:
```bash
curl -X POST https://api.agentmail.to/v0/inboxes/coachcarter/messages \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"to":"nayankt76@gmail.com","subject":"Test","text":"Hello"}'
```
Check the response JSON. Confirm:
- `message_id` field exists
- Value looks like an RFC 2822 Message-ID (e.g. `<abc123@mail.agentmail.to>`) not a plain UUID
- If it IS a plain UUID, update `lib/email.js` to return `data.message_id` still but note that webhook matching will use whatever format AgentMail puts in the `In-Reply-To` header of replies

- [ ] **Step 4: Verify webhook payload shape**

Go to AgentMail dashboard → webhook settings. Confirm:
- Field name for the original message reference: `in_reply_to` or `headers.in-reply-to`
- Field name for body text: `text` and/or `html`
- Signature verification: header name and format

Update `supabase/functions/on-reply/index.ts` lines 18-23 if field names differ from the plan.

- [ ] **Step 5: Configure webhook in AgentMail dashboard**

Set webhook URL to: `https://xhbamjjhzogrdkfymigk.supabase.co/functions/v1/on-reply`
Set webhook secret → copy the value → add to Supabase secrets:
```bash
npx supabase secrets set AGENTMAIL_WEBHOOK_SECRET=<secret> --project-ref xhbamjjhzogrdkfymigk
```

- [ ] **Step 6: Add AGENTMAIL_API_KEY to macOS keychain**

```bash
security add-generic-password -s "coachcarter-agentmail" -a "agentmail" -w "<your-agentmail-api-key>"
```

- [ ] **Step 7: Add AGENTMAIL_API_KEY to GitHub Actions secrets**

Go to github.com/nayankote/coachCarter → Settings → Secrets → New: `AGENTMAIL_API_KEY`

---

### Task 7: End-to-end verification

Note: any workouts already in `awaiting_feedback` status before Task 1 ran will have `session_data = null`. The Edge Function defaults athlete context to `{}` in that case, producing `?` in coaching output. For those stuck rows, run `finalize-coaching.js` locally instead (it has full plan context). Only newly analyzed workouts (after Task 1) will have full context in the Edge Function.

- [ ] **Step 1: Run analyze-workout on a recent workout**

Pick a workout UUID from Supabase that is currently at `status='synced'` (or reset one):
```bash
node scripts/analyze-workout.js <workout-uuid>
```
Expected: email arrives at `nayankt76@gmail.com` from `coachcarter@agentmail.to`

- [ ] **Step 2: Reply to the coaching email**

Reply with a short note. Check Supabase — workout status should change:
`awaiting_feedback` → `processing` → `complete`

Expected within ~30 seconds: final coaching report arrives threaded in the same email conversation.

- [ ] **Step 3: Check Supabase row**

Verify `workouts` row has:
- `status = 'complete'`
- `coaching_report` populated
- `compliance_score` populated (for strength; nil ok for unplanned)

---

### Task 8: Cleanup (only after Task 7 passes)

- [ ] **Step 1: Remove nodemailer and imapflow**

```bash
npm uninstall nodemailer imapflow
```

- [ ] **Step 2: Delete pollReplies stub from lib/email.js**

Remove the `pollReplies` stub function (Task 3 already removed ImapFlow — only the stub remains).

- [ ] **Step 3: Update COACHCARTER_EMAIL in .env**

Change:
```
COACHCARTER_EMAIL=nayankote.work@gmail.com
```
to:
```
COACHCARTER_EMAIL=coachcarter@agentmail.to
```

- [ ] **Step 4: Remove Gmail keychain entry**

```bash
security delete-generic-password -s "coachcarter-gmail"
```

Also remove `GMAIL_APP_PASSWORD` from GitHub Actions secrets (Settings → Secrets → delete).
Check `.github/workflows/*.yml` — if any workflow references `GMAIL_APP_PASSWORD`, remove it from the env block.

- [ ] **Step 5: Remove GMAIL_APP_PASSWORD from keychain.js ENV_VAR_MAP**

Delete the `'coachcarter-gmail': 'GMAIL_APP_PASSWORD'` line from `lib/keychain.js`.

- [ ] **Step 6: Run full test suite**

Run: `npx jest --no-coverage`
Expected: all tests pass

- [ ] **Step 7: Commit and push**

```bash
git add -A
git commit -m "chore: remove nodemailer/imapflow after AgentMail migration"
git push origin main
```
