// lib/athlete-context.js
const fs = require('fs');
const path = require('path');

function getContextPath() {
  return process.env.ATHLETE_CONTEXT_PATH || path.join(__dirname, '../athlete-context.json');
}

function loadGlobalContext() {
  return JSON.parse(fs.readFileSync(getContextPath(), 'utf8'));
}

// Queries last 28 days of workouts, daily_metrics, and daily_nudges from Supabase.
// Returns raw data + computed summary for coaching context.
async function buildRollingWindow(db, referenceDate) {
  const ref = new Date(referenceDate);
  const windowStart = new Date(ref);
  windowStart.setDate(ref.getDate() - 27); // 28-day window including reference date
  const startStr = windowStart.toISOString().split('T')[0];
  const endStr = ref.toISOString().split('T')[0];

  const [workoutsRes, metricsRes, nudgesRes] = await Promise.all([
    db.from('workouts')
      .select('id, sport, date, day_of_week, plan_session_id, compliance_score, status, duration_min, feedback')
      .neq('status', 'duplicate')
      .gte('date', startStr).lte('date', endStr)
      .order('date', { ascending: true }),
    db.from('daily_metrics')
      .select('*')
      .gte('date', startStr).lte('date', endStr)
      .order('date', { ascending: true }),
    db.from('daily_nudges')
      .select('*')
      .gte('date', startStr).lte('date', endStr)
      .order('date', { ascending: true }),
  ]);

  const workouts = workoutsRes.data || [];
  const dailyMetrics = metricsRes.data || [];
  const nudges = nudgesRes.data || [];

  const summary = computeSummary(workouts, dailyMetrics, nudges, startStr, endStr);

  return { workouts, dailyMetrics, nudges, summary, windowStart: startStr, windowEnd: endStr };
}

function computeSummary(workouts, dailyMetrics, nudges) {
  const completed = workouts.filter(w => w.status === 'complete');
  const withScores = completed.filter(w => w.compliance_score != null);

  // Compliance
  const avgCompliance = withScores.length
    ? Math.round(withScores.reduce((s, w) => s + w.compliance_score, 0) / withScores.length)
    : null;

  // Compliance by sport
  const bySport = {};
  for (const w of withScores) {
    if (!bySport[w.sport]) bySport[w.sport] = [];
    bySport[w.sport].push(w.compliance_score);
  }
  const complianceBySport = {};
  for (const [sport, scores] of Object.entries(bySport)) {
    complianceBySport[sport] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  // Missed sessions (nudges that were sent)
  const missedSessions = nudges
    .filter(n => n.nudge_type === 'evening')
    .map(n => ({
      date: n.date,
      session: n.session_id,
      reason: n.response || null,
    }));

  // Sleep trend: last 7 days vs prior 21 days
  let sleepAvg7d = null;
  let sleepAvgPrior = null;
  let bodyBatteryAvg = null;
  let poorNights = [];

  if (dailyMetrics.length) {
    const sorted = [...dailyMetrics].sort((a, b) => a.date.localeCompare(b.date));
    const last7 = sorted.slice(-7);
    const prior = sorted.slice(0, -7);

    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    const last7Scores = last7.filter(m => m.sleep_score != null).map(m => m.sleep_score);
    const priorScores = prior.filter(m => m.sleep_score != null).map(m => m.sleep_score);
    sleepAvg7d = avg(last7Scores);
    sleepAvgPrior = avg(priorScores);

    const bbStarts = last7.filter(m => m.body_battery_start != null).map(m => m.body_battery_start);
    bodyBatteryAvg = avg(bbStarts);

    poorNights = dailyMetrics
      .filter(m => m.sleep_score != null && m.sleep_score < 55)
      .map(m => ({ date: m.date, score: m.sleep_score }));
  }

  // Stress
  const stressScores = dailyMetrics.filter(m => m.stress_avg != null).map(m => m.stress_avg);
  const avgStress = stressScores.length
    ? Math.round(stressScores.reduce((a, b) => a + b, 0) / stressScores.length)
    : null;

  // Feedback themes (from workout feedback text — extract first 100 chars of each)
  const feedbackThemes = completed
    .filter(w => w.feedback)
    .map(w => ({ date: w.date, sport: w.sport, snippet: w.feedback.slice(0, 100) }))
    .slice(-5); // last 5 feedback entries

  return {
    totalWorkouts: workouts.length,
    completedWorkouts: completed.length,
    avgCompliance,
    complianceBySport,
    missedSessions,
    sleep: {
      avg7d: sleepAvg7d,
      avgPrior21d: sleepAvgPrior,
      trend: sleepAvg7d != null && sleepAvgPrior != null
        ? (sleepAvg7d >= sleepAvgPrior ? 'stable_or_improving' : 'declining')
        : 'insufficient_data',
      poorNights,
    },
    bodyBattery: { avgMorning7d: bodyBatteryAvg },
    stress: { avg: avgStress },
    feedbackThemes,
  };
}

// Serializes both context layers into structured text for Claude prompts.
// Target: <2000 tokens total.
function formatContextForPrompt(globalCtx, rollingWindow) {
  const lines = [];

  // Layer 1: Global context
  lines.push('=== ATHLETE CONTEXT (GLOBAL) ===');
  lines.push(`Season: ${globalCtx.season_phase}`);
  if (globalCtx.race_targets?.length) {
    lines.push(`Race targets: ${globalCtx.race_targets.map(r => `${r.event} (${r.date})`).join(', ')}`);
  }
  if (globalCtx.upcoming_life_events?.length) {
    for (const e of globalCtx.upcoming_life_events) {
      lines.push(`Life event: ${e.event} — ${e.dates} (${e.impact})`);
    }
  }
  lines.push(`Philosophy: ${globalCtx.training_philosophy}`);
  if (globalCtx.active_injuries?.length) {
    lines.push(`Active injuries: ${globalCtx.active_injuries.join(', ')}`);
  }
  if (globalCtx.known_patterns?.length) {
    lines.push(`Known patterns: ${globalCtx.known_patterns.join('; ')}`);
  }
  lines.push(`Nutrition: ${globalCtx.nutrition_context}`);
  lines.push(`Sleep baseline: score ~${globalCtx.sleep_baseline.typical_score}, ~${globalCtx.sleep_baseline.typical_hours}h. ${globalCtx.sleep_baseline.note}`);
  lines.push('');

  // Layer 2: Rolling 4-week window
  const s = rollingWindow.summary;
  lines.push(`=== ROLLING 4-WEEK WINDOW (${rollingWindow.windowStart} to ${rollingWindow.windowEnd}) ===`);
  lines.push(`Workouts: ${s.completedWorkouts} completed of ${s.totalWorkouts} tracked. Avg compliance: ${s.avgCompliance ?? 'N/A'}%`);

  if (Object.keys(s.complianceBySport).length) {
    const sportLine = Object.entries(s.complianceBySport).map(([k, v]) => `${k}: ${v}%`).join(', ');
    lines.push(`By sport: ${sportLine}`);
  }

  if (s.missedSessions.length) {
    lines.push(`Missed sessions (${s.missedSessions.length}):`);
    for (const m of s.missedSessions.slice(-6)) { // last 6
      lines.push(`  ${m.date} ${m.session}${m.reason ? ` — "${m.reason}"` : ''}`);
    }
  }

  lines.push(`Sleep (last 7d avg): ${s.sleep.avg7d ?? 'N/A'} | Prior 21d avg: ${s.sleep.avgPrior21d ?? 'N/A'} | Trend: ${s.sleep.trend}`);
  if (s.sleep.poorNights.length) {
    lines.push(`Poor nights (<55): ${s.sleep.poorNights.map(n => `${n.date} (${n.score})`).join(', ')}`);
  }
  lines.push(`Body Battery (morning avg 7d): ${s.bodyBattery.avgMorning7d ?? 'N/A'}`);
  lines.push(`Stress (avg): ${s.stress.avg ?? 'N/A'}`);

  if (s.feedbackThemes.length) {
    lines.push(`Recent feedback:`);
    for (const f of s.feedbackThemes) {
      lines.push(`  ${f.date} ${f.sport}: "${f.snippet}"`);
    }
  }

  return lines.join('\n');
}

module.exports = { loadGlobalContext, buildRollingWindow, formatContextForPrompt };
