// scripts/finalize-coaching.js
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { loadPlan, matchSession } = require('../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');

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
