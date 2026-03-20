// lib/coaching.js
const Anthropic = require('@anthropic-ai/sdk');
const { getSecret } = require('./keychain');

function getClient() {
  return new Anthropic({ apiKey: getSecret('coachcarter-anthropic') });
}

async function generateCoachingReport({ workout, metrics, session, feedback, plan }) {
  const client = getClient();
  const a = plan.athlete;

  const athleteCtx = `Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.`;

  const workoutCtx = `
${workout.day_of_week} ${workout.sport} — ${workout.date}
Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})
Duration: ${metrics.duration_min}min | Calories: ${metrics.calories || '—'}
${workout.sport === 'bike' ? `NP: ${metrics.normalized_power}W | VI: ${metrics.variability_index} | TSS: ${metrics.tss} | Intervals: ${metrics.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : ''}
${workout.sport === 'run'  ? `Avg pace: ${metrics.avg_pace_sec}s/km | Avg HR: ${metrics.avg_hr}bpm` : ''}
${workout.sport === 'swim' ? `Distance: ${metrics.total_distance_m}m | Main-set pace: ${metrics.main_set_pace_sec}s/100m` : ''}
Compliance: ${workout.compliance_score ?? 'TBD'}
Targets: ${JSON.stringify(session?.targets || {})}
Coaching notes: ${session?.coaching_notes || 'none'}
Athlete feedback: ${feedback || 'none'}
`.trim();

  const prompt = `You are a triathlon coach reviewing a completed workout. Write a 2–3 paragraph coaching report.

${athleteCtx}

${workoutCtx}

Be specific about what the numbers mean, acknowledge what went well, and identify what to improve. If compliance < 70, end with one concrete plan adjustment suggestion phrased as a question for the athlete to confirm.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// Extracts structured compliance from a strength session email reply
async function generateStrengthCompliance({ session, feedback }) {
  const client = getClient();
  const t = session.targets || {};
  const exercises = (t.exercises || [])
    .map(e => `${e.name}: ${e.sets}×${e.reps || e.distance_m + 'm'}${e.per_side ? '/side' : ''}`)
    .join('\n');

  const prompt = `Extract structured compliance data from this strength session reply.

Prescribed exercises:
${exercises}
Mobility: ${t.mobility_min || 0}min ${t.mobility_focus || ''}

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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(text);
}

// Generates a weekly training summary email (3–5 paragraphs)
async function generateWeeklyReport({ planWeek, weekStart, weekEnd, sessionStatuses, avgCompliance, priorWeekCompliance, plan }) {
  const client = getClient();
  const a = plan.athlete;

  const trend = priorWeekCompliance != null
    ? `Prior week compliance: ${priorWeekCompliance}% → this week: ${avgCompliance ?? 'incomplete'}`
    : 'No prior week data available for trend.';

  const sessionSummary = sessionStatuses
    .map(s => `  ${s.session}: ${s.status}${s.score != null ? ` (${s.score}%)` : ''}`)
    .join('\n');

  const prompt = `You are a triathlon coach writing a weekly training summary.

Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.

Week ${planWeek} (${weekStart} – ${weekEnd}):
${sessionSummary}
Overall compliance: ${avgCompliance ?? 'N/A'}%
${trend}

Write a 3–5 paragraph coaching summary covering:
1. What went well this week
2. What was missed and its likely impact
3. One specific plan.json adjustment if compliance was low (phrased as a question for the athlete to confirm)
4. Focus for next week`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

module.exports = { generateCoachingReport, generateStrengthCompliance, generateWeeklyReport };
