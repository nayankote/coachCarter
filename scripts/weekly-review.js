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
