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
