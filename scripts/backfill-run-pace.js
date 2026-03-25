// scripts/backfill-run-pace.js
// One-time script: re-extract avg_pace_sec for runs where it was never stored
// (predates the enhanced_speed fix in fit-parser.js).
// Safe to re-run — skips workouts that already have a value.
require('dotenv').config();
const { getSupabase } = require('../lib/supabase');
const { extractMetrics } = require('../lib/fit-parser');
const { loadPlan } = require('../lib/plan');

async function run() {
  const db = getSupabase();
  const plan = loadPlan();

  const { data: runs, error } = await db
    .from('workouts')
    .select('id, fit_file_path, avg_pace_sec, sport')
    .eq('sport', 'run')
    .is('avg_pace_sec', null);

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  if (!runs?.length) { console.log('[backfill-run-pace] No runs need backfilling'); return; }

  console.log(`[backfill-run-pace] ${runs.length} runs to backfill`);

  let success = 0, failed = 0;
  for (const workout of runs) {
    try {
      const { data: fitBlob, error: dlErr } = await db.storage.from('fit-files').download(workout.fit_file_path);
      if (dlErr) throw new Error(`Download failed: ${dlErr.message}`);
      const fitData = Buffer.from(await fitBlob.arrayBuffer());
      const metrics = await extractMetrics(fitData, 'run', plan.athlete);

      if (!metrics.avg_pace_sec) {
        console.warn(`  [skip] ${workout.id} — still null after re-parse`);
        failed++;
        continue;
      }

      await db.from('workouts').update({
        avg_pace_sec: metrics.avg_pace_sec,
        tss: metrics.tss ?? null,
        hr_drift: metrics.hr_drift ?? null,
      }).eq('id', workout.id);

      console.log(`  [ok] ${workout.id} → ${metrics.avg_pace_sec}s/km`);
      success++;
    } catch (err) {
      console.error(`  [err] ${workout.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[backfill-run-pace] Done: ${success} updated, ${failed} failed/skipped`);
}

run().catch(console.error);
