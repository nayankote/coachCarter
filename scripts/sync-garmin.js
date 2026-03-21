// scripts/sync-garmin.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createGarminClient, getActivitiesSince, downloadFitFile, deduplicateBikes } = require('../lib/garmin');
const { getSupabase } = require('../lib/supabase');
const { run: analyzeWorkout } = require('./analyze-workout');

async function run() {
  const db = getSupabase();

  // 1. Read last_synced_at
  const { data: state } = await db.from('sync_state').select('last_synced_at').eq('id', 1).single();
  const since = new Date(state.last_synced_at);
  console.log(`[sync-garmin] Syncing since ${since.toISOString()}`);

  // 2. Auth + fetch
  const client = await createGarminClient();
  let activities = await getActivitiesSince(client, since);
  activities = deduplicateBikes(activities);
  console.log(`[sync-garmin] ${activities.length} new activities`);

  // 3. Process each — store then immediately analyze inline
  for (const activity of activities) {
    const workoutId = await processActivity(client, db, activity);
    if (workoutId) {
      try {
        await analyzeWorkout(workoutId);
      } catch (err) {
        console.error(`[sync-garmin] analyze-workout failed for ${workoutId}:`, err.message);
        // Row stays at status="synced" and will be retried on next cron run
      }
    }
  }

  // 4. Retry rows stuck at status="synced" older than 10 minutes
  await retryStuck(db);

  // 5. Update sync_state
  await db.from('sync_state').update({ last_synced_at: new Date().toISOString() }).eq('id', 1);
  console.log('[sync-garmin] Done');
}

// Returns the new workout UUID, or null on failure
async function processActivity(client, db, activity) {
  const { activityId, activityType, startTimeLocal } = activity;
  const sport = normalizeSport(activityType?.typeKey);
  const date = startTimeLocal?.split(' ')[0];

  const fitBuffer = await downloadFitFile(client, activityId);
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
