// lib/email-templates.js

function buildEmailBody(workout, metrics, session) {
  const { sport, day_of_week } = workout;

  if (!session) {
    return `Unplanned ${sport} detected — ${metrics.duration_min}min` +
      (metrics.distance_km ? `, ${metrics.distance_km}km` : '') +
      `.\nNo prescription to match. How did it go and what was this session for?`;
  }

  if (sport === 'bike')     return buildBikeEmail(metrics, session);
  if (sport === 'run')      return buildRunEmail(metrics, session);
  if (sport === 'swim')     return buildSwimEmail(metrics, session);
  if (sport === 'strength') return buildStrengthEmail(metrics, session, day_of_week);
  return `${day_of_week} ${sport} done — ${metrics.duration_min}min. How did it go?`;
}

function buildBikeEmail(metrics, session) {
  const t = session.targets?.main_set || {};
  const np = metrics.normalized_power;
  const inRange = np && t.power_min && np >= t.power_min && np <= t.power_max;
  return [
    `${session.day} bike done. ${metrics.duration_min}min,`,
    np ? `NP ${np}W (target ${t.power_min}–${t.power_max}W ${inRange ? '✓' : '✗'}),` : '',
    metrics.variability_index ? `VI ${metrics.variability_index} ${metrics.variability_index <= session.targets?.vi_max ? '✓' : '✗'},` : '',
    metrics.intervals_detected ? `${metrics.intervals_detected.work_intervals}/${t.sets} intervals,` : '',
    `TSS ${metrics.tss || '—'} (target ${session.targets?.tss_target || '—'}).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].filter(Boolean).join(' ');
}

function buildRunEmail(metrics, session) {
  const t = session.targets || {};
  return [
    `${session.day} run done. ${metrics.duration_min}min,`,
    `avg pace ${metrics.avg_pace_sec ? formatPace(metrics.avg_pace_sec) : '—'}/km`,
    `(target ${t.pace_min_sec ? formatPace(t.pace_min_sec) : '—'}–${t.pace_max_sec ? formatPace(t.pace_max_sec) : '—'}/km),`,
    `avg HR ${metrics.avg_hr || '—'}bpm (limit ${t.hr_max || '—'}bpm).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].join(' ');
}

function buildSwimEmail(metrics, session) {
  const t = session.targets || {};
  return [
    `${session.day} swim done. ${metrics.distance_km ? Math.round(metrics.distance_km * 1000) : '—'}m (target ${t.total_distance_m || '—'}m),`,
    `avg pace ${metrics.avg_pace_sec ? formatPace100(metrics.avg_pace_sec) : '—'}/100m`,
    `(target ${t.main_set?.css_target_sec_per_100m ? formatPace100(t.main_set.css_target_sec_per_100m) : '—'}/100m).`,
    `\nHow did it feel? Scale 1–10, and what went well / didn't?`,
  ].join(' ');
}

function buildStrengthEmail(metrics, session, dayOfWeek) {
  const t = session.targets || {};
  const exercises = (t.exercises || [])
    .map(e => `${e.name} ${e.sets}×${e.reps || (e.distance_m + 'm')}${e.per_side ? '/side' : ''}`)
    .join(', ');
  return [
    `${dayOfWeek} ${session.type} Strength done — ${metrics.duration_min}min, ${metrics.calories}kcal.`,
    exercises ? `\nPrescribed: ${exercises}` : '',
    t.mobility_min ? ` + ${t.mobility_min}min ${t.mobility_focus || 'mobility'}.` : '.',
    `\n\nQuick check-in:`,
    `\n1. What weights did you use?`,
    `\n2. All sets and reps done, or anything cut?`,
    `\n3. Full ${t.mobility_min || '—'}min mobility or shorter?`,
    `\n4. RPE 1–10, and anything that felt off?`,
  ].join('');
}

function formatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  return `${m}:${String(secPerKm % 60).padStart(2, '0')}`;
}

function formatPace100(secPer100m) { return formatPace(secPer100m); }

module.exports = { buildEmailBody };
