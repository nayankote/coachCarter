// scripts/build-frontend-data.js
// Fetches workout data from Supabase and writes static JSON for the frontend.
// Run by GitHub Actions — never call directly with real secrets in browser.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../lib/supabase');

function extractFeedbackText(raw) {
  if (!raw) return null;
  // Old Gmail workouts: raw MIME email. Extract plain text body.
  if (raw.startsWith('Delivered-To:') || raw.startsWith('Received:')) {
    // Handle both \r\n and \n line endings — Supabase may normalize to \n
    const sep = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
    const bodyStart = raw.indexOf(sep);
    if (bodyStart === -1) return null;
    const body = raw.slice(bodyStart + sep.length);
    // Strip MIME boundary lines (--000...) and quoted reply (lines starting with >)
    return body
      .split(/\r?\n/)
      .filter(l => !l.startsWith('--') && !l.startsWith('>') && !l.startsWith('On '))
      .join('\n')
      .trim()
      .slice(0, 800);
  }
  // AgentMail workouts: already plain text
  return raw.slice(0, 800);
}

async function run() {
  const db = getSupabase();
  const { data: workouts, error } = await db
    .from('workouts')
    .select('id,garmin_activity_id,sport,date,day_of_week,plan_week,plan_session_id,duration_min,calories,avg_hr,tss,normalized_power,variability_index,intensity_factor,avg_pace_sec,distance_km,compliance_score,compliance_breakdown,coaching_report,feedback,status,start_time')
    .order('date', { ascending: true });

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

  // Clean feedback field before writing to public JSON
  const cleaned = workouts.map(w => ({
    ...w,
    feedback: extractFeedbackText(w.feedback),
  }));

  const docsDir = path.join(__dirname, '..', 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  fs.writeFileSync(
    path.join(docsDir, 'workouts.json'),
    JSON.stringify(cleaned, null, 2)
  );

  // Copy plan.json to docs/
  const plan = fs.readFileSync(path.join(__dirname, '..', 'plan.json'), 'utf8');
  fs.writeFileSync(path.join(docsDir, 'plan.json'), plan);

  console.log(`[build-frontend] wrote ${cleaned.length} workouts to docs/workouts.json`);
}

run().catch(err => { console.error(err); process.exit(1); });
