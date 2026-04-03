// scripts/evaluate-plan.js
// Sunday look-ahead: evaluates the upcoming week's plan against current athlete state.
// Runs at 9pm IST (3:30pm UTC) on Sundays, after the weekly review.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getSupabase } = require('../lib/supabase');
const { loadPlan, calcPlanWeek } = require('../lib/plan');
const { evaluateUpcomingWeek } = require('../lib/coaching');
const { sendFeedbackEmail } = require('../lib/email');
const { loadGlobalContext, buildRollingWindow, formatContextForPrompt } = require('../lib/athlete-context');

function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function run() {
  const db = getSupabase();
  const plan = loadPlan();
  const today = getTodayIST();

  // Calculate NEXT week's plan week (tomorrow is Monday)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const nextPlanWeek = calcPlanWeek(plan.plan_start_date, tomorrowStr);

  const weekPlan = plan.weeks.find(w => w.week === nextPlanWeek);
  if (!weekPlan) {
    console.log(`[evaluate-plan] No plan found for week ${nextPlanWeek} — skipping`);
    return;
  }

  // Build full context
  const globalCtx = loadGlobalContext();
  const rollingWindow = await buildRollingWindow(db, today);
  const context = formatContextForPrompt(globalCtx, rollingWindow);

  const result = await evaluateUpcomingWeek({
    planWeek: nextPlanWeek,
    weekLabel: weekPlan.label,
    sessions: weekPlan.sessions,
    context,
  });

  if (result.proposal) {
    // Send proposal email
    const { messageId } = await sendFeedbackEmail({
      to: process.env.ATHLETE_EMAIL,
      subject: `[CoachCarter] Week ${nextPlanWeek} plan review — proposed adjustment`,
      body: result.proposal,
    });

    // Store in plan_proposals
    await db.from('plan_proposals').insert({
      source: 'evaluate_plan',
      plan_week: nextPlanWeek,
      status: 'proposed',
      proposal_text: result.proposal,
      email_message_id: messageId,
    });

    console.log(`[evaluate-plan] Proposal sent for week ${nextPlanWeek}: ${result.reason}`);
  } else {
    // Send confirmation message
    await sendFeedbackEmail({
      to: process.env.ATHLETE_EMAIL,
      subject: `[CoachCarter] Week ${nextPlanWeek} (${weekPlan.label}) — plan confirmed`,
      body: result.message,
    });

    console.log(`[evaluate-plan] Week ${nextPlanWeek} plan confirmed — no changes needed`);
  }
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
