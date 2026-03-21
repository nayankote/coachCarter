// scripts/sync-garmin.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createGarminClient, getNewActivities, downloadFitFile, deduplicateBikes } = require('../lib/garmin');
const { getSupabase } = require('../lib/supabase');
const { run: analyzeWorkout } = require('./analyze-workout');

async function run() {
  const db = getSupabase();

  // Load all known Garmin activity IDs from Supabase so we know when to stop fetching
  const { data: existing } = await db.from('workouts').select('garmin_activity_id');
  const knownIds = new Set((existing || []).map(r => String(r.garmin_activity_id)));
  console.log(`[sync-garmin] ${knownIds.size} activities already in DB`);

  // Fetch only new activities — stops automatically once a full page is already known
  const client = await createGarminClient();
  let activities = await getNewActivities(client, knownIds);
  activities = deduplicateBikes(activities);
  console.log(`[sync-garmin] ${activities.length} new activities to sync`);

  let newCount = 0;
  for (const activity of activities) {
    const workoutId = await processActivity(client, db, activity);
    if (workoutId) {
      newCount++;
      try {
        await analyzeWorkout(workoutId);
      } catch (err) {
        console.error(`[sync-garmin] analyze-workout failed for ${workoutId}:`, err.message);
      }
    }
  }
  console.log(`[sync-garmin] ${newCount} new activities synced`);

  // Retry rows stuck at status="synced" older than 10 minutes
  await retryStuck(db);

  console.log('[sync-garmin] Done');
}

// Returns the new workout UUID, or null on failure
async function processActivity(client, db, activity) {
  const { activityId, activityType, startTimeLocal } = activity;
  const sport = normalizeSport(activityType?.typeKey);
  const date = startTimeLocal?.split(' ')[0];

  let fitBuffer;
  try {
    fitBuffer = await downloadFitFile(client, activityId);
  } catch (err) {
    console.warn(`[sync-garmin] No FIT file for ${activityId} (${sport} ${date}) — skipping: ${err.message}`);
    return null;
  }
  const fitPath = `fit-files/${date}_${sport}_${activityId}.fit`;

  const { error: uploadError } = await db.storage.from('fit-files').upload(fitPath, fitBuffer);
  if (uploadError) {
    console.error(`[sync-garmin] Upload failed for ${activityId}:`, uploadError.message);
    return null;
  }

  const { data: inserted, error: insertError } = await db.from('workouts').insert({
    garmin_activity_id: activityId,
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
    return null;
  }

  console.log(`[sync-garmin] Stored ${sport} ${activityId} → ${inserted.id}`);
  return inserted.id;
}

async function retryStuck(db) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: stuck } = await db.from('workouts').select('id').eq('status', 'synced').lt('created_at', cutoff);
  if (!stuck?.length) return;
  console.log(`[sync-garmin] Retrying ${stuck.length} stuck rows`);
  for (const { id } of stuck) {
    try { await analyzeWorkout(id); }
    catch (err) { console.error(`[sync-garmin] Retry failed for ${id}:`, err.message); }
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
