---
name: finalize-coaching
description: Combine FIT metrics + athlete email reply to produce a coaching report
trigger: run after IMAP polling detects a reply
---

# /finalize-coaching {id}

Runs after an athlete reply has been stored on a workout row. Calls Claude to generate a coaching report and — for strength sessions — computes compliance from the reply text.

## Steps

1. Poll the CoachCarter inbox for new replies:
   ```bash
   cd coachCarter && node -e "
     require('dotenv').config();
     const { pollReplies } = require('./lib/email');
     const { getSupabase } = require('./lib/supabase');
     const db = getSupabase();
     pollReplies({ onReply: async ({ inReplyTo, body }) => {
       const { data } = await db.from('workouts').select('id').eq('email_message_id', inReplyTo).single();
       if (data) {
         await db.from('workouts').update({ feedback: body, feedback_received_at: new Date().toISOString() }).eq('id', data.id);
         console.log('Reply stored for workout:', data.id);
       }
     }});
   "
   ```

2. For each workout ID where feedback was just stored:
   ```bash
   node scripts/finalize-coaching.js {id}
   ```

3. Report: compliance_score and the first 2 lines of coaching_report.

4. If compliance < 70: the report ends with a plan adjustment suggestion. Confirm with the athlete before running /update-plan.
