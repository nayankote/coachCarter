// scripts/test-agentmail-e2e.js
// End-to-end test for AgentMail integration:
//   1. Sends a test coaching email via AgentMail
//   2. Creates a dummy workout row in Supabase with that email_message_id
//   3. POSTs a fake webhook to the Edge Function simulating an athlete reply
//   4. Polls Supabase until the workout is marked 'complete'
//   5. Cleans up the dummy row
require('dotenv').config();
const { getSecret } = require('../lib/keychain');
const { sendFeedbackEmail } = require('../lib/email');
const { getSupabase } = require('../lib/supabase');

const EDGE_FN_URL = 'https://xhbamjjhzogrdkfymigk.supabase.co/functions/v1/on-reply';
const ATHLETE_EMAIL = process.env.ATHLETE_EMAIL;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const db = getSupabase();
  let workoutId;

  try {
    // --- Step 1: Send a test coaching email ---
    console.log('\n[test] Step 1: Sending test coaching email via AgentMail...');
    const { messageId } = await sendFeedbackEmail({
      to: ATHLETE_EMAIL,
      subject: '[CoachCarter] Test — AgentMail integration check',
      body: 'This is a test coaching email. Reply to trigger the webhook.',
    });
    console.log(`[test] Email sent. messageId: ${messageId}`);

    // --- Step 2: Insert a dummy workout row ---
    console.log('\n[test] Step 2: Inserting dummy workout into Supabase...');
    const { data: workout, error } = await db.from('workouts').insert({
      garmin_activity_id: 9999999999,
      sport: 'bike',
      date: new Date().toISOString().split('T')[0],
      day_of_week: 'Saturday',
      start_time: new Date().toISOString(),
      duration_min: 60,
      status: 'awaiting_feedback',
      email_message_id: messageId,
    }).select().single();

    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    workoutId = workout.id;
    console.log(`[test] Dummy workout created. id: ${workoutId}`);

    // --- Step 3: POST fake webhook to Edge Function ---
    console.log('\n[test] Step 3: POSTing fake athlete reply to Edge Function...');
    const webhookSecret = getSecret('coachcarter-agentmail-webhook');
    const webhookPayload = {
      message_id: '<fake-reply-001@agentmail.to>',
      in_reply_to: messageId,
      from: ATHLETE_EMAIL,
      subject: 'Re: [CoachCarter] Test — AgentMail integration check',
      text: 'Felt good! Completed the full session, legs felt strong throughout. HR stayed in zone 2 the whole time.',
    };

    const res = await fetch(EDGE_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agentmail-signature': webhookSecret,
      },
      body: JSON.stringify(webhookPayload),
    });
    console.log(`[test] Webhook response: ${res.status} ${res.statusText}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Edge Function returned ${res.status}: ${body}`);
    }

    // --- Step 4: Poll for completion ---
    console.log('\n[test] Step 4: Waiting for Edge Function to process...');
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const { data: updated } = await db.from('workouts').select('status, coaching_report').eq('id', workoutId).single();
      console.log(`[test]   status: ${updated.status}`);
      if (updated.status === 'complete') {
        console.log('\n[test] SUCCESS! Workout marked complete.');
        console.log('[test] Coaching report preview:');
        console.log(updated.coaching_report?.slice(0, 300) + '...');
        break;
      }
      if (updated.status === 'awaiting_feedback') {
        throw new Error('Status reset to awaiting_feedback — Edge Function likely hit an error (check Supabase logs)');
      }
    }

  } finally {
    // --- Step 5: Cleanup ---
    if (workoutId) {
      console.log(`\n[test] Cleaning up dummy workout ${workoutId}...`);
      await db.from('workouts').delete().eq('id', workoutId);
      console.log('[test] Done.');
    }
  }
}

run().catch(err => {
  console.error('\n[test] FAILED:', err.message);
  process.exit(1);
});
