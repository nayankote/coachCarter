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
