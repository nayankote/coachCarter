// lib/fit-parser.js
const FitParser = require('fit-file-parser').default;

function parseFit(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'km' });
    parser.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

// athlete = { ftp, run_threshold_sec_per_km } — passed from plan.json at call site
async function extractMetrics(buffer, sport, athlete = {}) {
  const data = await parseFit(buffer);
  // fit-file-parser places sessions at data.sessions[], not nested under data.activity
  const session = data.sessions?.[0] || {};
  // Records are at data.records[], not nested inside laps
  const records = data.records || [];

  const base = {
    duration_min: session.total_elapsed_time ? +(session.total_elapsed_time / 60).toFixed(1) : null,
    calories: session.total_calories || null,
    start_time: session.start_time || null,
    end_time: session.timestamp || null,
  };

  if (sport === 'strength') return base;

  const avg_hr = session.avg_heart_rate || null;
  const max_hr = session.max_heart_rate || null;
  // With lengthUnit: 'km', total_distance is already in km
  const distance_km = session.total_distance ? +session.total_distance.toFixed(2) : null;
  const ftp = athlete.ftp;
  const runThreshold = athlete.run_threshold_sec_per_km;

  if (sport === 'bike') {
    if (!ftp) throw new Error('extractMetrics: athlete.ftp is required for bike sport');
    const powerRecords = records.map(r => r.power).filter(Boolean);
    const avg_power = session.avg_power || (powerRecords.length ? Math.round(mean(powerRecords)) : null);
    const normalized_power = calculateNP(powerRecords);
    const variability_index = (normalized_power && avg_power) ? +(normalized_power / avg_power).toFixed(3) : null;
    const intensity_factor = normalized_power ? +(normalized_power / ftp).toFixed(3) : null;
    const tss = (normalized_power && intensity_factor && session.total_elapsed_time)
      ? Math.round((session.total_elapsed_time * normalized_power * intensity_factor) / (ftp * 3600) * 100)
      : null;
    const hr_drift = calculateHrDrift(records);
    const power_distribution = calculatePowerZones(powerRecords, ftp);
    const intervals_detected = detectIntervals(powerRecords, ftp);
    return { ...base, avg_hr, max_hr, hr_drift, avg_power, normalized_power, variability_index,
      intensity_factor, tss, power_distribution, distance_km,
      efficiency: { hr_drift }, intervals_detected };
  }

  if (sport === 'run') {
    if (!runThreshold) throw new Error('extractMetrics: athlete.run_threshold_sec_per_km is required for run sport');
    const speedRecords = records.map(r => r.speed).filter(Boolean);
    const avg_speed_kmh = speedRecords.length ? mean(speedRecords) : null;
    const avg_pace_sec = avg_speed_kmh ? Math.round(3600 / avg_speed_kmh) : null;
    const hr_drift = calculateHrDrift(records);
    const tss = calculateRunTSS(session.total_elapsed_time, avg_pace_sec, runThreshold);
    return { ...base, avg_hr, max_hr, hr_drift, avg_pace_sec, distance_km, tss,
      efficiency: { hr_drift } };
  }

  if (sport === 'swim') {
    // total_distance is in km (lengthUnit: 'km') — convert to metres
    const total_distance_m = session.total_distance ? Math.round(session.total_distance * 1000) : null;
    // Use enhanced_avg_speed (km/h) when available for active-swim pace (excludes rest intervals)
    const avg_speed_kmh = session.enhanced_avg_speed || session.avg_speed || null;
    const avg_pace_sec = avg_speed_kmh ? Math.round(360 / avg_speed_kmh) : null;
    // Main-set pace: fastest sustained block from per-length speeds (km/h in lengths[])
    const lengths = data.lengths || [];
    const main_set_pace_sec = estimateMainSetPaceSwim(lengths);
    return { ...base, avg_hr, total_distance_m, avg_pace_sec, main_set_pace_sec, distance_km };
  }

  return base;
}

// --- Calculation helpers ---

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateNP(powerRecords) {
  if (powerRecords.length < 30) return null;
  const windowSize = 30;
  const rolling = [];
  for (let i = windowSize - 1; i < powerRecords.length; i++) {
    rolling.push(mean(powerRecords.slice(i - windowSize + 1, i + 1)));
  }
  return Math.round(Math.pow(mean(rolling.map(v => Math.pow(v, 4))), 0.25));
}

function calculateHrDrift(records) {
  const hrs = records.map(r => r.heart_rate).filter(Boolean);
  if (hrs.length < 20) return null;
  const mid = Math.floor(hrs.length / 2);
  const firstHalf = mean(hrs.slice(0, mid));
  const secondHalf = mean(hrs.slice(mid));
  return Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
}

function calculatePowerZones(powerRecords, ftp) {
  if (!powerRecords.length) return null;
  const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const p of powerRecords) {
    const pct = p / ftp;
    if (pct < 0.56) zones.z1++;
    else if (pct < 0.76) zones.z2++;
    else if (pct < 0.91) zones.z3++;
    else if (pct < 1.06) zones.z4++;
    else zones.z5++;
  }
  const total = powerRecords.length;
  return Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, Math.round(v / total * 100)]));
}

function detectIntervals(powerRecords, ftp) {
  if (!powerRecords.length) return null;
  const threshold = ftp * 0.85;
  let inInterval = false;
  let intervalCount = 0;
  const workPowers = [];
  let currentWork = [];

  for (const p of powerRecords) {
    if (p >= threshold) {
      if (!inInterval) { inInterval = true; intervalCount++; currentWork = []; }
      currentWork.push(p);
    } else {
      if (inInterval) {
        inInterval = false;
        if (currentWork.length >= 5) workPowers.push(...currentWork);
      }
    }
  }
  return {
    work_intervals: intervalCount,
    avg_work_power: workPowers.length ? Math.round(mean(workPowers)) : null,
  };
}

function calculateRunTSS(durationSec, avgPaceSec, runThresholdSecPerKm) {
  if (!durationSec || !avgPaceSec || !runThresholdSecPerKm) return null;
  const intensityFactor = runThresholdSecPerKm / avgPaceSec;
  return Math.round((durationSec * intensityFactor * intensityFactor) / 3600 * 100);
}

// Estimates main-set pace from per-length avg_speed values (km/h, from parser lengthUnit: 'km').
// Finds the fastest sustained window of active lengths and converts to sec/100m.
function estimateMainSetPaceSwim(lengths) {
  const activeSpeeds = lengths
    .filter(l => l.length_type === 'active' && l.avg_speed)
    .map(l => l.avg_speed); // km/h
  if (activeSpeeds.length < 3) return null;
  const windowSize = Math.min(6, Math.floor(activeSpeeds.length / 2));
  let bestAvg = 0;
  for (let i = 0; i <= activeSpeeds.length - windowSize; i++) {
    const w = mean(activeSpeeds.slice(i, i + windowSize));
    if (w > bestAvg) bestAvg = w;
  }
  // km/h → sec/100m: 360 / speed_kmh
  return bestAvg ? Math.round(360 / bestAvg) : null;
}

module.exports = { parseFit, extractMetrics };
