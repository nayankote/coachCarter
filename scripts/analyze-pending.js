// scripts/analyze-pending.js
// Picks up workouts with status 'synced' or 'analyzing' (stuck) and runs analysis.
// Runs in the cloud (GitHub Actions) on a 15-minute cron — decoupled from Garmin sync.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getSupabase } = require('../lib/supabase');
const { run: analyzeWorkout } = require('./analyze-workout');

async function run() {
  const db = getSupabase();

  // Find all unprocessed workouts: 'synced' (never started) or 'analyzing' (started but crashed)
  const { data: pending } = await db.from('workouts')
    .select('id, sport, date, status')
    .in('status', ['synced', 'analyzing'])
    .neq('status', 'duplicate')
    .order('created_at', { ascending: true });

  if (!pending?.length) {
    console.log('[analyze-pending] No pending workouts');
    return;
  }

  console.log(`[analyze-pending] ${pending.length} workout(s) to process`);

  let success = 0;
  let failed = 0;
  for (const workout of pending) {
    try {
      await analyzeWorkout(workout.id);
      success++;
      console.log(`[analyze-pending] ${workout.id} (${workout.sport} ${workout.date}) — done`);
    } catch (err) {
      failed++;
      console.error(`[analyze-pending] ${workout.id} failed: ${err.message}`);
    }
  }

  console.log(`[analyze-pending] Done: ${success} processed, ${failed} failed`);
}

module.exports = { run };
if (require.main === module) run().catch(console.error);
