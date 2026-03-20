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

  const { data: fitBlob } = await db.storage.from('fit-files').download(workout.fit_file_path);
  const fitData = Buffer.from(await fitBlob.arrayBuffer());

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
