// scripts/morning-followup.js
// Morning follow-up: checks for unanswered evening nudges and sends a forward-looking message.
// Runs at 7am IST (1:30am UTC) via GitHub Actions cron.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getSupabase } = require('../lib/supabase');
const { loadPlan, calcPlanWeek } = require('../lib/plan');
const { generateMorningFollowup } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');
const { loadGlobalContext, buildRollingWindow, formatContextForPrompt } = require('../lib/athlete-context');

function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getYesterdayIST() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getDayOfWeekIST() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' });
}

async function run() {
  const db = getSupabase();
  const plan = loadPlan();
  const today = getTodayIST();
  const yesterday = getYesterdayIST();
  const dayOfWeek = getDayOfWeekIST();

  // Check for unanswered evening nudges from yesterday
  const { data: unansweredNudges } = await db.from('daily_nudges')
    .select('*')
    .eq('date', yesterday)
    .eq('nudge_type', 'evening')
    .is('response', null);

  // Get today's planned sessions
  const planWeek = calcPlanWeek(plan.plan_start_date, today);
  const weekPlan = plan.weeks.find(w => w.week === planWeek);
  const todaySessions = (weekPlan?.sessions || []).filter(s => s.day === dayOfWeek);

  const hasUnanswered = unansweredNudges && unansweredNudges.length > 0;

  // Only send if there are unanswered nudges OR today has planned sessions
  if (!hasUnanswered && !todaySessions.length) {
    console.log(`[morning-followup] No unanswered nudges and no sessions today — skipping`);
    return;
  }

  // Check for existing morning nudge (idempotency)
  const { data: existingMorning } = await db.from('daily_nudges')
    .select('id')
    .eq('date', today)
    .eq('nudge_type', 'morning')
    .limit(1);

  if (existingMorning?.length) {
    console.log(`[morning-followup] Morning follow-up already sent for ${today}`);
    return;
  }

  // Build context
  const globalCtx = loadGlobalContext();
  const rollingWindow = await buildRollingWindow(db, today);
  const context = formatContextForPrompt(globalCtx, rollingWindow);

  const followupText = await generateMorningFollowup({
    date: today,
    context,
    unansweredNudges: unansweredNudges || [],
    todaySessions,
  });

  const { messageId } = await sendFeedbackEmail({
    to: process.env.ATHLETE_EMAIL,
    subject: `[CoachCarter] Good morning — ${dayOfWeek} plan`,
    body: followupText,
  });

  // Record a single morning nudge row (session_id = 'morning_followup' since it covers the whole day)
  await db.from('daily_nudges').insert({
    date: today,
    session_id: 'morning_followup',
    nudge_type: 'morning',
    email_message_id: messageId,
  });

  console.log(`[morning-followup] Sent morning follow-up for ${today}${hasUnanswered ? ` (${unansweredNudges.length} unanswered nudges)` : ''}`);
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
