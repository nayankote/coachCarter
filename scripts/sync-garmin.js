// scripts/sync-garmin.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createGarminClient, getNewActivities, downloadFitFile, deduplicateBikes, getSleepAndWellness } = require('../lib/garmin');
const { getMultiSportSessions } = require('../lib/fit-parser');
const { getSupabase } = require('../lib/supabase');

async function run() {
  const db = getSupabase();

  // Load all known Garmin activity IDs from Supabase.
  // For multi_sport sub-sessions we store synthetic IDs (parentId * 10 + index).
  // Also add the parent ID so the stop condition correctly skips already-synced races.
  const { data: existing } = await db.from('workouts').select('garmin_activity_id');
  const knownIds = new Set();
  for (const r of (existing || [])) {
    knownIds.add(String(r.garmin_activity_id));
    knownIds.add(String(Math.floor(r.garmin_activity_id / 10))); // parent of any synthetic ID
  }
  console.log(`[sync-garmin] ${existing?.length ?? 0} activities already in DB`);

  const client = await createGarminClient();
  const activities = await getNewActivities(client, knownIds);
  const { keep, duplicates } = deduplicateBikes(activities);

  for (const activity of duplicates) {
    await insertDuplicate(client, db, activity);
  }

  console.log(`[sync-garmin] ${keep.length} new activities to sync`);

  let newCount = 0;
  for (const activity of keep) {
    const workoutIds = await processActivity(client, db, activity);
    newCount += workoutIds.length;
  }
  console.log(`[sync-garmin] ${newCount} new activities synced (status: synced, awaiting analysis)`);

  // --- Daily metrics sync (sleep, body battery, stress) ---
  await syncDailyMetrics(client, db);

  console.log('[sync-garmin] Done');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function syncDailyMetrics(garminClient, db) {
  // Determine date range: if daily_metrics is empty, backfill 28 days. Otherwise from last entry to yesterday.
  const { data: latest } = await db.from('daily_metrics')
    .select('date').order('date', { ascending: false }).limit(1);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let startDate;
  if (!latest?.length) {
    // First run: backfill 28 days
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 28);
    console.log('[sync-garmin] First daily_metrics run — backfilling 28 days');
  } else {
    // Sync from day after last entry
    startDate = new Date(latest[0].date);
    startDate.setDate(startDate.getDate() + 1);
  }

  const startStr = startDate.toISOString().split('T')[0];
  if (startStr > yesterdayStr) {
    console.log('[sync-garmin] Daily metrics already up to date');
    return;
  }

  let syncCount = 0;
  const current = new Date(startDate);
  while (current.toISOString().split('T')[0] <= yesterdayStr) {
    const dateStr = current.toISOString().split('T')[0];
    try {
      const metrics = await getSleepAndWellness(garminClient, dateStr);
      const { error } = await db.from('daily_metrics').upsert(metrics, { onConflict: 'date' });
      if (error) {
        console.warn(`[sync-garmin] daily_metrics upsert failed for ${dateStr}: ${error.message}`);
      } else {
        syncCount++;
      }
    } catch (err) {
      console.warn(`[sync-garmin] daily_metrics failed for ${dateStr}: ${err.message}`);
    }
    await sleep(2000); // rate limit
    current.setDate(current.getDate() + 1);
  }

  console.log(`[sync-garmin] ${syncCount} daily_metrics days synced`);
}

// Returns array of new workout UUIDs (empty on failure, multiple for multi_sport)
async function processActivity(client, db, activity) {
  const { activityId, activityType, startTimeLocal } = activity;
  const sport = normalizeSport(activityType?.typeKey);
  const date = startTimeLocal?.split(' ')[0];

  let fitBuffer;
  try {
    fitBuffer = await downloadFitFile(client, activityId);
  } catch (err) {
    console.warn(`[sync-garmin] No FIT file for ${activityId} (${sport} ${date}) — skipping: ${err.message}`);
    return [];
  }

  if (sport === 'multi_sport') {
    return await processMultiSport(db, activityId, activity.activityName, startTimeLocal, date, fitBuffer);
  }

  // DB-level bike dedup: if a bike already exists on this date whose time window overlaps
  // with the new activity, skip it as a duplicate (e.g. Zwift + watch recording the same ride).
  // Back-to-back rides won't overlap even if close together, so they're kept.
  if (sport === 'bike') {
    const { data: existing } = await db.from('workouts').select('id,start_time,duration_min').eq('date', date).eq('sport', 'bike');
    if (existing?.length) {
      const newStart = activity.startTimeLocal ? new Date(activity.startTimeLocal).getTime() : null;
      const newEnd   = newStart && activity.duration ? newStart + activity.duration * 1000 : null;
      const isDuplicate = existing.some(w => {
        if (!newStart || !newEnd || !w.start_time || !w.duration_min) return false;
        const exStart = new Date(w.start_time).getTime();
        const exEnd   = exStart + w.duration_min * 60 * 1000;
        return newStart < exEnd && newEnd > exStart; // intervals overlap
      });
      if (isDuplicate) {
        console.log(`[sync-garmin] Recording duplicate bike on ${date} — time window overlaps with existing ride`);
        await insertDuplicate(client, db, activity);
        return [];
      }
    }
  }

  const fitPath = `fit-files/${date}_${sport}_${activityId}.fit`;
  const { error: uploadError } = await db.storage.from('fit-files').upload(fitPath, fitBuffer, { upsert: true });
  if (uploadError) {
    console.error(`[sync-garmin] Upload failed for ${activityId}:`, uploadError.message);
    return [];
  }

  const { data: inserted, error: insertError } = await db.from('workouts').insert({
    garmin_activity_id: activityId,
    activity_name: activity.activityName || null,
    sport,
    date,
    day_of_week: getDayOfWeek(startTimeLocal),
    start_time: startTimeLocal,
    fit_file_path: fitPath,
    status: 'synced',
  }).select('id').single();

  if (insertError) {
    if (insertError.code === '23505') {
      console.log(`[sync-garmin] Activity ${activityId} already stored — skipping`);
    } else {
      console.error(`[sync-garmin] Insert failed for ${activityId}:`, insertError.message);
    }
    return [];
  }

  console.log(`[sync-garmin] Stored ${sport} ${activityId} → ${inserted.id}`);
  return [inserted.id];
}

async function processMultiSport(db, activityId, activityName, startTimeLocal, date, fitBuffer) {
  // Upload the FIT file once — all sub-sessions share the same file
  const fitPath = `fit-files/${date}_multi_sport_${activityId}.fit`;
  const { error: uploadError } = await db.storage.from('fit-files').upload(fitPath, fitBuffer, { upsert: true });
  if (uploadError) {
    console.error(`[sync-garmin] Multi_sport upload failed for ${activityId}:`, uploadError.message);
    return [];
  }

  const sessions = await getMultiSportSessions(fitBuffer);
  const workoutIds = [];

  for (const sess of sessions) {
    const syntheticId = activityId * 10 + sess.index;
    const sportLabel = sess.sport.charAt(0).toUpperCase() + sess.sport.slice(1);
    const sessionDate = sess.start_time
      ? `${sess.start_time.getFullYear()}-${String(sess.start_time.getMonth()+1).padStart(2,'0')}-${String(sess.start_time.getDate()).padStart(2,'0')}`
      : date;

    const { data: inserted, error: insertError } = await db.from('workouts').insert({
      garmin_activity_id: syntheticId,
      activity_name: `${activityName} — ${sportLabel}`,
      sport: sess.sport,
      date: sessionDate,
      day_of_week: getDayOfWeek(startTimeLocal),
      start_time: sess.start_time,
      fit_file_path: fitPath,
      status: 'synced',
    }).select('id').single();

    if (insertError) {
      if (insertError.code === '23505') {
        console.log(`[sync-garmin] Sub-session ${syntheticId} already stored — skipping`);
      } else {
        console.error(`[sync-garmin] Insert failed for sub-session ${syntheticId}:`, insertError.message);
      }
      continue;
    }

    console.log(`[sync-garmin] Stored ${sess.sport} leg ${sess.index} ${syntheticId} → ${inserted.id}`);
    workoutIds.push(inserted.id);
  }

  return workoutIds;
}

async function insertDuplicate(client, db, activity) {
  const { activityId, activityType, startTimeLocal, activityName } = activity;
  const sport = normalizeSport(activityType?.typeKey);
  const date = startTimeLocal?.split(' ')[0];

  let fitBuffer;
  try {
    fitBuffer = await downloadFitFile(client, activityId);
  } catch (err) {
    console.warn(`[sync-garmin] No FIT file for duplicate ${activityId} (${sport} ${date}) — skipping FIT upload: ${err.message}`);
  }

  let fitPath = null;
  if (fitBuffer) {
    fitPath = `fit-files/${date}_${sport}_${activityId}.fit`;
    const { error: uploadError } = await db.storage.from('fit-files').upload(fitPath, fitBuffer, { upsert: true });
    if (uploadError) {
      console.warn(`[sync-garmin] FIT upload failed for duplicate ${activityId}: ${uploadError.message}`);
      fitPath = null;
    }
  }

  const { error } = await db.from('workouts').insert({
    garmin_activity_id: activityId,
    activity_name: activityName || null,
    sport,
    date,
    day_of_week: getDayOfWeek(startTimeLocal),
    start_time: startTimeLocal,
    fit_file_path: fitPath,
    status: 'duplicate',
  });

  if (error) {
    if (error.code === '23505') {
      // Already in DB (either as a real workout or a prior duplicate) — skip silently
      return;
    }
    console.warn(`[sync-garmin] Failed to record duplicate ${activityId}: ${error.message}`);
  } else {
    console.log(`[sync-garmin] Recorded duplicate ${sport} ${activityId} (${date})`);
  }
}

function normalizeSport(typeKey = '') {
  if (typeKey.includes('cycling') || typeKey === 'virtual_ride') return 'bike';
  if (typeKey.includes('running')) return 'run';
  if (typeKey.includes('swimming')) return 'swim';
  if (typeKey.includes('strength') || typeKey.includes('training')) return 'strength';
  return typeKey || 'unknown';
}

function getDayOfWeek(dateStr) {
  if (!dateStr) return null;
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(dateStr).getDay()];
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
