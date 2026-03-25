// lib/compliance.js

function scoreCompliance(session, metrics) {
  const { sport } = session;
  const targets = session.targets || {};

  if (sport === 'strength') return { score: null, breakdown: { note: 'scored from email reply' } };
  if (sport === 'bike')     return scoreBike(targets, metrics);
  if (sport === 'run')      return scoreRun(targets, metrics);
  if (sport === 'swim')     return scoreSwim(targets, metrics);
  return { score: null, breakdown: { note: `no scorer for sport: ${sport}` } };
}

function scoreBike(targets, metrics) {
  const factors = [];
  const breakdown = {};

  const sets = targets.main_set?.sets;
  const actual = metrics.intervals_detected?.work_intervals;
  if (sets != null && actual != null) {
    breakdown.intervals = actual >= sets;
    factors.push({ pass: breakdown.intervals, weight: 3 });
  }

  const { power_min, power_max } = targets.main_set || {};
  const np = metrics.normalized_power;
  if (power_min != null && power_max != null && np != null) {
    breakdown.power_in_range = np >= power_min && np <= power_max;
    factors.push({ pass: breakdown.power_in_range, weight: 3 });
  }

  if (targets.vi_max != null && metrics.variability_index != null) {
    breakdown.vi_ok = metrics.variability_index <= targets.vi_max;
    factors.push({ pass: breakdown.vi_ok, weight: 2 });
  }

  if (targets.duration_min != null && metrics.duration_min != null) {
    breakdown.duration_ok = Math.abs(metrics.duration_min - targets.duration_min) / targets.duration_min <= 0.15;
    factors.push({ pass: breakdown.duration_ok, weight: 2 });
  }

  return { score: calcScore(factors), breakdown };
}

function scoreRun(targets, metrics) {
  const factors = [];
  const breakdown = {};

  if (targets.pace_min_sec != null && metrics.avg_pace_sec != null) {
    breakdown.pace_in_range = metrics.avg_pace_sec >= targets.pace_min_sec && metrics.avg_pace_sec <= targets.pace_max_sec;
    factors.push({ pass: breakdown.pace_in_range, weight: 4 });
  }

  if (targets.hr_max != null && metrics.avg_hr != null) {
    breakdown.hr_ok = metrics.avg_hr <= targets.hr_max;
    factors.push({ pass: breakdown.hr_ok, weight: 4 });
  }

  if (targets.duration_min != null && metrics.duration_min != null) {
    breakdown.duration_ok = Math.abs(metrics.duration_min - targets.duration_min) / targets.duration_min <= 0.15;
    factors.push({ pass: breakdown.duration_ok, weight: 2 });
  }

  return { score: calcScore(factors), breakdown };
}

function scoreSwim(targets, metrics) {
  const factors = [];
  const breakdown = {};

  const targetPace = targets.main_set?.css_target_sec_per_100m;
  if (targetPace != null && metrics.avg_pace_sec != null) {
    // Fail only if slower than CSS by >5s — being faster than CSS is fine (sprints drag avg up)
    breakdown.pace_ok = metrics.avg_pace_sec <= targetPace + 5;
    factors.push({ pass: breakdown.pace_ok, weight: 5 });
  }

  const actualDistanceM = metrics.distance_km != null ? Math.round(metrics.distance_km * 1000) : null;
  if (targets.total_distance_m != null && actualDistanceM != null) {
    breakdown.distance_ok = actualDistanceM >= targets.total_distance_m * 0.95;
    factors.push({ pass: breakdown.distance_ok, weight: 5 });
  }

  return { score: calcScore(factors), breakdown };
}

// Weighted pass/fail → 0–100
function calcScore(factors) {
  if (!factors.length) return null;
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const passedWeight = factors.filter(f => f.pass).reduce((s, f) => s + f.weight, 0);
  return Math.round((passedWeight / totalWeight) * 100);
}

module.exports = { scoreCompliance };
