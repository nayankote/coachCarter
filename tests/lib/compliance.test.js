const { scoreCompliance } = require('../../lib/compliance');

const bikeSession = {
  sport: 'bike', type: 'intervals', duration_min: 60,
  targets: { main_set: { sets: 3, power_min: 171, power_max: 181 }, vi_max: 1.05, duration_min: 60 },
};

test('bike: full compliance returns 100', () => {
  const metrics = { intervals_detected: { work_intervals: 3 }, normalized_power: 175, variability_index: 1.02, duration_min: 60 };
  expect(scoreCompliance(bikeSession, metrics).score).toBe(100);
});

test('bike: missed all intervals reduces score significantly', () => {
  const metrics = { intervals_detected: { work_intervals: 0 }, normalized_power: 175, variability_index: 1.02, duration_min: 60 };
  const { score, breakdown } = scoreCompliance(bikeSession, metrics);
  expect(score).toBeLessThan(80);
  expect(breakdown.intervals).toBe(false);
});

test('bike: power out of range reduces score', () => {
  const metrics = { intervals_detected: { work_intervals: 3 }, normalized_power: 150, variability_index: 1.02, duration_min: 60 };
  expect(scoreCompliance(bikeSession, metrics).score).toBeLessThan(100);
});

const runSession = {
  sport: 'run', type: 'z2', duration_min: 30,
  targets: { pace_min_sec: 345, pace_max_sec: 375, hr_max: 145, duration_min: 30 },
};

test('run: in-zone pace and HR returns 100', () => {
  expect(scoreCompliance(runSession, { avg_pace_sec: 360, avg_hr: 140, duration_min: 30 }).score).toBe(100);
});

test('run: HR over limit reduces score', () => {
  expect(scoreCompliance(runSession, { avg_pace_sec: 360, avg_hr: 160, duration_min: 30 }).score).toBeLessThan(100);
});

const swimSession = {
  sport: 'swim', type: 'technique', duration_min: 60,
  // Note: field name is css_target_sec_per_100m per plan.json schema;
  // compliance scorer reads targets.main_set.css_target_sec_per_100m
  targets: { total_distance_m: 2200, main_set: { css_target_sec_per_100m: 180 } },
};

test('swim: on-target pace and distance returns 100', () => {
  expect(scoreCompliance(swimSession, { main_set_pace_sec: 180, total_distance_m: 2200 }).score).toBe(100);
});

test('swim: short distance reduces score', () => {
  expect(scoreCompliance(swimSession, { main_set_pace_sec: 180, total_distance_m: 1800 }).score).toBeLessThan(100);
});

test('strength: returns null score (email-only)', () => {
  expect(scoreCompliance({ sport: 'strength' }, {}).score).toBeNull();
});
