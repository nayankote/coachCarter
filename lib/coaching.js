// lib/coaching.js
const Anthropic = require('@anthropic-ai/sdk');
const { getSecret } = require('./keychain');

function getClient() {
  return new Anthropic({ apiKey: getSecret('coachcarter-anthropic') });
}

const PLAN_STABILITY_DOCTRINE = `
PLAN STABILITY DOCTRINE — You MUST follow these rules:

The default state of the plan is CORRECT. Your job is to help the athlete EXECUTE the plan, not rewrite it.
Most feedback is informational — acknowledge it, adjust coaching tone, and move on. The plan itself changes rarely.

Only THREE triggers justify even CONSIDERING a plan change:
1. EXPLICIT ATHLETE REQUEST — the athlete directly asks to change something.
2. STRUCTURAL IMPOSSIBILITY — equipment gone, schedule permanently changed, injury preventing a movement. Must be permanent/recurring, not a one-off miss.
3. SUSTAINED PATTERN OVER 3+ WEEKS — the same session missed or failed 3 weeks running.

Everything else gets a coaching note only. "Felt heavy" → coaching note. "RPE was high" → coaching note. "Didn't complete all reps" → coaching note.

COMPLIANCE GUARDRAIL: If overall compliance is above 70%, do NOT propose structural changes. Focus on accountability and execution support.

Even when a trigger fires, default to "this is an execution problem, not a plan problem." Every proposal must explicitly answer: "Why is this a plan problem and not an execution problem?"

When uncertain, ASK rather than propose.
`.trim();

const COACHING_PERSONALITY = `
You are a triathlon coach. Be direct and data-led. Lead with numbers, not feelings.
Be blunt but not mean. Call out problems clearly. Offer solutions, not just observations.
Believe in the plan — changes are proposed reluctantly with clear justification.
Reference recent patterns, not just the current session.
Coach, not cheerleader — acknowledge good work briefly, spend more time on what to improve.
Every interaction should end with a clear next action or expectation.
When performance is off and sleep/recovery data explains it, say so directly.
`.trim();

async function generateCoachingReport({ workout, metrics, session, feedback, plan, context }) {
  const client = getClient();
  const a = plan.athlete;

  const athleteCtx = `Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.`;

  const workoutCtx = `
${workout.day_of_week} ${workout.sport} — ${workout.date}
Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})
Duration: ${metrics.duration_min}min | Calories: ${metrics.calories || '—'}
${workout.sport === 'bike' ? `NP: ${metrics.normalized_power}W | VI: ${metrics.variability_index} | TSS: ${metrics.tss} | Intervals: ${metrics.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : ''}
${workout.sport === 'run'  ? `Avg pace: ${metrics.avg_pace_sec}s/km | Avg HR: ${metrics.avg_hr}bpm` : ''}
${workout.sport === 'swim' ? `Distance: ${metrics.distance_km ? Math.round(metrics.distance_km * 1000) : '—'}m | Avg pace: ${metrics.avg_pace_sec ?? '—'}s/100m` : ''}
Compliance: ${workout.compliance_score ?? 'TBD'}
Targets: ${JSON.stringify(session?.targets || {})}
Coaching notes: ${session?.coaching_notes || 'none'}
Athlete feedback: ${feedback || 'none'}
`.trim();

  const contextBlock = context ? `\n\n${context}\n` : '';

  const prompt = `${COACHING_PERSONALITY}

${athleteCtx}
${contextBlock}
${workoutCtx}

Write a short, direct coaching note — 4–6 sentences max, no headers, no fluff.
Lead with the key numbers and what they mean. Call out 1–2 high-impact actionables for next time. Be blunt.
Do NOT comment on whether exercises should be kept or removed from the plan. Stick to session feedback only — what happened, how it went, what to focus on next time.
If the athlete requests a plan change or raises a concern, acknowledge it and say it will be addressed separately. If compliance < 70, include one concrete plan adjustment.`;

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
async function generateWeeklyReport({ planWeek, weekStart, weekEnd, sessionStatuses, avgCompliance, priorWeekCompliance, plan, context }) {
  const client = getClient();
  const a = plan.athlete;

  const trend = priorWeekCompliance != null
    ? `Prior week compliance: ${priorWeekCompliance}% → this week: ${avgCompliance ?? 'incomplete'}`
    : 'No prior week data available for trend.';

  const sessionSummary = sessionStatuses
    .map(s => `  ${s.session}: ${s.status}${s.score != null ? ` (${s.score}%)` : ''}`)
    .join('\n');

  const contextBlock = context ? `\n\n${context}\n` : '';

  const prompt = `${COACHING_PERSONALITY}

${PLAN_STABILITY_DOCTRINE}

Athlete: FTP ${a.ftp}W, LTHR ${a.lthr}bpm, run threshold ${a.run_threshold_sec_per_km}s/km, swim CSS ${a.swim_css_sec_per_100m}s/100m.
${contextBlock}
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

// Generates a calibrated evening nudge for missed workout(s)
async function generateMissedWorkoutNudge({ sessions, date, context }) {
  const client = getClient();
  const sessionList = sessions.map(s => `${s.id} (${s.sport}, ${s.duration_min}min)`).join(', ');

  const prompt = `${COACHING_PERSONALITY}

${PLAN_STABILITY_DOCTRINE}

${context}

Today is ${date}. The following planned session(s) were NOT completed today: ${sessionList}.

Write a calibrated evening check-in message (3–5 sentences). Rules:
- If recent context shows a pattern of misses, be more direct and reference the pattern.
- If sleep data shows poor recovery, be empathetic — skipping may have been the right call.
- If this is a one-off with no concerning pattern, keep it light.
- Always ask what happened (schedule, fatigue, or something else?).
- End with a forward reference to tomorrow's session if applicable.
- Do NOT suggest plan changes unless a Plan Stability Doctrine trigger is clearly met.
- No subject line, no headers — just the message text.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// Morning follow-up for unanswered evening nudges
async function generateMorningFollowup({ date, context, unansweredNudges, todaySessions }) {
  const client = getClient();
  const nudgeList = unansweredNudges.map(n => `${n.session_id} on ${n.date}`).join(', ');
  const todayList = todaySessions?.length
    ? todaySessions.map(s => `${s.id} (${s.sport}, ${s.duration_min}min)`).join(', ')
    : 'rest day';

  const prompt = `${COACHING_PERSONALITY}

${context}

Today is ${date}. ${unansweredNudges.length ? `Yesterday's evening check-in about ${nudgeList} got no response.` : ''}
Today's plan: ${todayList}.

Write a brief, forward-looking morning message (2–4 sentences). Rules:
- If there were unanswered nudges, acknowledge briefly but don't harp.
- Focus on today — what's planned and any relevant context (sleep, recovery).
- End with a clear expectation for today.
- No subject line, no headers — just the message text.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// Sunday look-ahead: evaluate upcoming week's plan against current athlete state.
// Returns { proposal: string } if changes needed, or null if plan is good.
async function evaluateUpcomingWeek({ planWeek, weekLabel, sessions, context }) {
  const client = getClient();
  const sessionList = sessions
    .map(s => `${s.day} ${s.sport} — ${s.id} (${s.type}, ${s.duration_min}min)`)
    .join('\n');

  const prompt = `${COACHING_PERSONALITY}

${PLAN_STABILITY_DOCTRINE}

${context}

UPCOMING WEEK: Week ${planWeek} (${weekLabel})
${sessionList}

Evaluate whether this upcoming week's plan is appropriate given the athlete's current state (load, sleep, compliance patterns, life context).

First, output a JSON line:
{"proposal_needed": true/false, "reason": "brief explanation"}

Then, if proposal_needed is true, write a concise proposal. Say what needs to be said, nothing more. Use bullet points, not tables. No pipe characters or ASCII tables — this is a plain-text email.
Cover: what's changing and why, why it's a plan problem, tradeoffs, when to re-evaluate.

If proposal_needed is false, write a brief (3–5 sentence) forward-looking message confirming the plan. Reference specific sessions and any context the athlete should be aware of.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;

  // Parse the JSON line to determine if a proposal was generated
  const jsonMatch = text.match(/^\{.*"proposal_needed"\s*:\s*(true|false).*\}/m);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]);
    const body = text.slice(jsonMatch.index + jsonMatch[0].length).trim();
    if (parsed.proposal_needed) {
      return { proposal: body, reason: parsed.reason };
    }
    return { proposal: null, message: body };
  }

  // Fallback: treat as no proposal
  return { proposal: null, message: text };
}

// Evaluates athlete feedback against Plan Stability Doctrine triggers.
// Returns { triggered: bool, trigger: string|null, reasoning: string }
async function evaluateFeedbackTriggers({ feedback, context }) {
  const client = getClient();

  const prompt = `${PLAN_STABILITY_DOCTRINE}

${context}

Athlete feedback:
"${feedback}"

Evaluate this feedback against the Plan Stability Doctrine. Does it meet ANY of the three triggers?
1. Explicit athlete request to change something
2. Structural impossibility (equipment, schedule, injury — permanent, not one-off)
3. Part of a sustained 3+ week pattern (check the rolling window data above)

IMPORTANT — these are NOT triggers:
- Questions about exercises ("what is X?", "is X useful?") → coaching note, not a trigger
- Expressing preferences ("I prefer reps over minutes") → coaching note unless it makes the current plan impossible
- Reporting difficulty ("X feels extreme", "Y is hard") → coaching note, difficulty is expected
- Feedback about a single session → coaching note, one session is never a pattern
- Describing what they did differently ("did X with dumbbells") → coaching note, this is execution info

Default to triggered:false. When in doubt, it's not a trigger.

Return JSON only:
{"triggered": true/false, "trigger": "trigger_1|trigger_2|trigger_3|none", "reasoning": "brief explanation"}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(text);
}

// Generates a structured plan proposal (used when a trigger fires).
async function generatePlanProposal({ trigger, feedback, context, coachingReport }) {
  const client = getClient();

  const coachingReportBlock = coachingReport
    ? `\nIMPORTANT — You already sent this coaching report to the athlete moments ago:\n"${coachingReport}"\n\nYour proposal MUST be consistent with the coaching report above. Do not contradict advice you just gave.\n`
    : '';

  const prompt = `${COACHING_PERSONALITY}

${PLAN_STABILITY_DOCTRINE}

${context}
${coachingReportBlock}
A Plan Stability Doctrine trigger has fired: ${trigger}
Athlete feedback: "${feedback}"

Generate a plan change proposal. Be concise — say what needs to be said, nothing more. Use bullet points, not tables. No pipe characters or ASCII tables — this is a plain-text email.

Cover:
- What's changing and why
- Why this is a plan problem, not an execution problem
- Any tradeoffs
- When to re-evaluate

End with: "Reply YES to approve, NO to decline, or suggest an alternative."`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

module.exports = {
  generateCoachingReport,
  generateStrengthCompliance,
  generateWeeklyReport,
  generateMissedWorkoutNudge,
  generateMorningFollowup,
  evaluateUpcomingWeek,
  evaluateFeedbackTriggers,
  generatePlanProposal,
  PLAN_STABILITY_DOCTRINE,
  COACHING_PERSONALITY,
};
