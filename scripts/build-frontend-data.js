// scripts/build-frontend-data.js
// Fetches workout data from Supabase and writes static JSON for the frontend.
// Run by GitHub Actions — never call directly with real secrets in browser.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../lib/supabase');

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractFeedbackText(raw) {
  if (!raw) return null;

  const isMime = raw.startsWith('Delivered-To:') || raw.startsWith('Received:') || raw.startsWith('Content-Type:');
  if (!isMime) return raw.slice(0, 800); // AgentMail plain text

  // Locate the text/plain MIME part anywhere in the raw email
  const plainTypeIdx = raw.search(/Content-Type:\s*text\/plain/i);
  if (plainTypeIdx === -1) return null;

  // Find the blank line that ends the part's headers
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const blankLine = eol + eol;
  const partHeaderEnd = raw.indexOf(blankLine, plainTypeIdx);
  if (partHeaderEnd === -1) return null;

  // Detect QP from that part's headers only
  const partHeaders = raw.slice(plainTypeIdx, partHeaderEnd);
  const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(partHeaders);

  let body = raw.slice(partHeaderEnd + blankLine.length);

  // Stop at MIME boundary (--xxx) or next Content-Type header
  const stopMatch = body.match(/--[^\s]{5}|[\r\n]Content-Type:/i);
  if (stopMatch) body = body.slice(0, stopMatch.index);

  if (isQP) body = decodeQuotedPrintable(body);

  return body
    .split(/\r?\n/)
    .filter(l => !l.startsWith('>') && !l.startsWith('On '))
    .join('\n')
    .trim()
    .slice(0, 800);
}

async function run() {
  const db = getSupabase();
  const { data: workouts, error } = await db
    .from('workouts')
    .select('id,garmin_activity_id,activity_name,sport,date,day_of_week,plan_week,plan_session_id,duration_min,calories,avg_hr,min_hr,max_hr,avg_power,tss,normalized_power,variability_index,intensity_factor,hr_drift,avg_pace_sec,distance_km,intervals_detected,power_distribution,compliance_score,compliance_breakdown,coaching_report,feedback,status,start_time')
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
