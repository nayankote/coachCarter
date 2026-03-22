// supabase/functions/on-reply/index.ts
import { createClient } from 'npm:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Read body once — needed for both signature verification and JSON parsing
  const rawBody = await req.text();

  const webhookSecret = Deno.env.get('AGENTMAIL_WEBHOOK_SECRET');
  if (webhookSecret) {
    const svixId        = req.headers.get('svix-id');
    const svixTimestamp = req.headers.get('svix-timestamp');
    const svixSignature = req.headers.get('svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.error('[on-reply] Missing Svix signature headers');
      return new Response('Unauthorized', { status: 401 });
    }

    // Svix signs: "<svix-id>.<svix-timestamp>.<raw-body>"
    const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;

    // Secret is base64-encoded after stripping optional "whsec_" prefix
    const secretBase64 = webhookSecret.startsWith('whsec_')
      ? webhookSecret.slice(6)
      : webhookSecret;
    const keyBytes = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
    const computed = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)));

    // svix-signature may contain multiple space-separated sigs (e.g. "v1,abc v1,xyz")
    const valid = svixSignature.split(' ').some(s => s === computed);
    if (!valid) {
      console.error('[on-reply] Invalid Svix signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // AgentMail wraps the email under payload.message; in_reply_to may be a Gmail-assigned ID
  // so we also check the references array which contains our original SES message ID
  const message   = payload.message ?? payload;
  const inReplyTo = message.in_reply_to ?? message.headers?.['In-Reply-To'];
  const references: string[] = message.references ?? [];
  const replyBody = cleanReplyText(message.extracted_text ?? stripHtml(message.html ?? ''));

  if (!replyBody) {
    console.log('[on-reply] Missing reply body — ignoring');
    return new Response('OK', { status: 200 });
  }

  // Match workout by in_reply_to first, then fall back to references array.
  // in_reply_to may be a Gmail-assigned ID; our SES message ID appears in references.
  let workout: any = null;
  const candidates = [inReplyTo, ...references].filter(Boolean);
  for (const msgId of candidates) {
    const { data } = await supabase.from('workouts').select('*').eq('email_message_id', msgId).single();
    if (data) { workout = data; break; }
  }

  if (!workout) {
    console.log(`[on-reply] No workout found for any of: ${candidates.join(', ')}`);
    return new Response('OK', { status: 200 });
  }

  // Atomic status transition — prevents double-fire from webhook retries
  const { data: locked } = await supabase
    .from('workouts')
    .update({ status: 'processing' })
    .eq('id', workout.id)
    .eq('status', 'awaiting_feedback')
    .select()
    .single();

  if (!locked) {
    console.log(`[on-reply] Workout ${workout.id} already processing or complete — skipping`);
    return new Response('OK', { status: 200 });
  }

  try {
    const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')!;
    const agentmailKey   = Deno.env.get('AGENTMAIL_API_KEY')!;
    const agentmailInbox = Deno.env.get('AGENTMAIL_INBOX')!;
    const athleteEmail   = Deno.env.get('ATHLETE_EMAIL')!;

    const sessionData = workout.session_data ?? {};
    const session     = sessionData.session ?? null;
    const athlete     = sessionData.athlete ?? {};

    let complianceScore     = workout.compliance_score;
    let complianceBreakdown = workout.compliance_breakdown;

    // Strength: extract structured compliance from reply text
    if (workout.sport === 'strength' && session) {
      const prompt = buildStrengthPrompt(session, replyBody);
      const raw    = await callAnthropic(anthropicKey, prompt, 400);
      const parsed = JSON.parse(raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());
      complianceScore     = parsed.compliance_score;
      complianceBreakdown = parsed;
    }

    // Generate coaching report
    const coachingReport = await callAnthropic(
      anthropicKey,
      buildCoachingPrompt(workout, athlete, session, replyBody, complianceScore),
      250
    );

    // Send coaching report as threaded reply
    await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `[CoachCarter] ${workout.day_of_week} ${workout.sport} — coaching report`,
      text: coachingReport,
      replyToMessageId: inReplyTo,
    });

    // Mark complete
    await supabase.from('workouts').update({
      status: 'complete',
      feedback: replyBody,
      compliance_score: complianceScore,
      compliance_breakdown: complianceBreakdown,
      coaching_report: coachingReport,
    }).eq('id', workout.id);

    console.log(`[on-reply] ${workout.id} complete, score=${complianceScore}`);
    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('[on-reply] Error:', err);
    // Reset so next Svix retry can proceed
    await supabase.from('workouts').update({ status: 'awaiting_feedback' }).eq('id', workout.id);
    return new Response('Internal error', { status: 500 });
  }
});

async function callAnthropic(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

async function sendViaAgentMail(
  apiKey: string,
  inbox: string,
  { to, subject, text, replyToMessageId }: { to: string; subject: string; text: string; replyToMessageId?: string }
) {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to, subject, text,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AgentMail error ${res.status}: ${await res.text()}`);
}

function buildStrengthPrompt(session: any, feedback: string): string {
  const exercises = (session.targets?.exercises ?? [])
    .map((e: any) => `${e.name}: ${e.sets}×${e.reps || e.distance_m + 'm'}${e.per_side ? '/side' : ''}`)
    .join('\n');
  return `Extract structured compliance data from this strength session reply.

Prescribed exercises:
${exercises}
Mobility: ${session.targets?.mobility_min ?? 0}min ${session.targets?.mobility_focus ?? ''}

Athlete reply:
${feedback}

Return JSON only:
{
  "exercises_completed": [{"name": "...", "sets_done": 0, "reps_done": 0, "weight_kg": 0}],
  "all_exercises_done": true,
  "mobility_done_min": 0,
  "rpe": 0,
  "compliance_score": 0
}`;
}

function buildCoachingPrompt(
  workout: any,
  athlete: any,
  session: any,
  feedback: string,
  complianceScore: number | null
): string {
  const athleteCtx = `Athlete: FTP ${athlete.ftp ?? '?'}W, LTHR ${athlete.lthr ?? '?'}bpm, run threshold ${athlete.run_threshold_sec_per_km ?? '?'}s/km, swim CSS ${athlete.swim_css_sec_per_100m ?? '?'}s/100m.`;
  const workoutCtx = [
    `${workout.day_of_week} ${workout.sport} — ${workout.date}`,
    `Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})`,
    `Duration: ${workout.duration_min}min | Calories: ${workout.calories ?? '—'}`,
    workout.sport === 'bike' ? `NP: ${workout.normalized_power}W | VI: ${workout.variability_index} | TSS: ${workout.tss} | Intervals: ${workout.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : '',
    workout.sport === 'run'  ? `Avg pace: ${workout.avg_pace_sec}s/km | Avg HR: ${workout.avg_hr}bpm` : '',
    workout.sport === 'swim' ? `Distance: ${workout.total_distance_m}m | Main-set pace: ${workout.main_set_pace_sec}s/100m` : '',
    `Compliance: ${complianceScore ?? 'N/A'}`,
    `Targets: ${JSON.stringify(session?.targets ?? {})}`,
    `Coaching notes: ${session?.coaching_notes ?? 'none'}`,
    `Athlete feedback: ${feedback}`,
  ].filter(Boolean).join('\n');

  return `You are a triathlon coach. Write a short, direct coaching note — 4–6 sentences max, no headers, no fluff.

${athleteCtx}

${workoutCtx}

Lead with the key numbers and what they mean. Call out 1–2 high-impact actionables for next time. Be blunt.${complianceScore != null && complianceScore < 70 ? ' Include one concrete plan adjustment.' : ''}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanReplyText(text: string): string {
  if (!text) return text;
  // Strip email signature (standard "-- " delimiter)
  const sigMatch = text.match(/\n--\s*\n/);
  if (sigMatch) text = text.slice(0, sigMatch.index);
  // Strip quoted thread lines
  return text
    .split('\n')
    .filter(l => !l.startsWith('>') && !l.startsWith('On '))
    .join('\n')
    .trim()
    .slice(0, 800);
}
