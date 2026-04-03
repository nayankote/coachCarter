// scripts/daily-reconcile.js
// Evening nudge: detects missed planned sessions and sends a calibrated check-in.
// Runs at 10pm IST (4:30pm UTC) via GitHub Actions cron.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getSupabase } = require('../lib/supabase');
const { loadPlan, calcPlanWeek } = require('../lib/plan');
const { generateMissedWorkoutNudge } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');
const { loadGlobalContext, buildRollingWindow, formatContextForPrompt } = require('../lib/athlete-context');

function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getDayOfWeekIST() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' });
}

async function run() {
  const db = getSupabase();
  const plan = loadPlan();
  const today = getTodayIST();
  const dayOfWeek = getDayOfWeekIST();

  const planWeek = calcPlanWeek(plan.plan_start_date, today);
  const weekPlan = plan.weeks.find(w => w.week === planWeek);
  const todaySessions = (weekPlan?.sessions || []).filter(s => s.day === dayOfWeek);

  if (!todaySessions.length) {
    console.log(`[daily-reconcile] No planned sessions for ${dayOfWeek} ${today} — nothing to check`);
    return;
  }

  // Get today's completed workouts
  const { data: workouts } = await db.from('workouts')
    .select('plan_session_id, sport, status')
    .neq('status', 'duplicate')
    .eq('date', today);

  const completedIds = new Set((workouts || []).map(w => w.plan_session_id).filter(Boolean));

  // Find missed sessions (not matched by any workout)
  const missedSessions = todaySessions.filter(s => !completedIds.has(s.id));

  if (!missedSessions.length) {
    console.log(`[daily-reconcile] All ${todaySessions.length} planned sessions done for ${today}`);
    return;
  }

  // Check for existing nudges (idempotency)
  const { data: existingNudges } = await db.from('daily_nudges')
    .select('session_id')
    .eq('date', today)
    .eq('nudge_type', 'evening');

  const alreadyNudged = new Set((existingNudges || []).map(n => n.session_id));
  const toNudge = missedSessions.filter(s => !alreadyNudged.has(s.id));

  if (!toNudge.length) {
    console.log(`[daily-reconcile] Nudges already sent for missed sessions on ${today}`);
    return;
  }

  // Build coaching context
  const globalCtx = loadGlobalContext();
  const rollingWindow = await buildRollingWindow(db, today);
  const context = formatContextForPrompt(globalCtx, rollingWindow);

  // Generate and send nudge
  const nudgeText = await generateMissedWorkoutNudge({ sessions: toNudge, date: today, context });
  const sessionIds = toNudge.map(s => s.id).join(', ');

  const { messageId } = await sendFeedbackEmail({
    to: process.env.ATHLETE_EMAIL,
    subject: `[CoachCarter] Missed ${dayOfWeek} ${toNudge.map(s => s.sport).join('/')} — checking in`,
    body: nudgeText,
  });

  // Insert nudge records
  for (const session of toNudge) {
    await db.from('daily_nudges').insert({
      date: today,
      session_id: session.id,
      nudge_type: 'evening',
      email_message_id: messageId,
    });
  }

  console.log(`[daily-reconcile] Sent evening nudge for ${sessionIds} on ${today}`);
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
