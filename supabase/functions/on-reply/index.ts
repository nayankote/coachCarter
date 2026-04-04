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
  const message            = payload.message ?? payload;
  const incomingMessageId  = message.id;  // AgentMail internal UUID of the athlete's reply
  const inReplyTo          = message.in_reply_to ?? message.headers?.['In-Reply-To'];
  const references: string[] = message.references ?? [];
  const replyBody = cleanReplyText(message.extracted_text ?? stripHtml(message.html ?? ''));

  if (!replyBody) {
    console.log('[on-reply] Missing reply body — ignoring');
    return new Response('OK', { status: 200 });
  }

  const candidates = [inReplyTo, ...references].filter(Boolean);

  // --- Route 1: Check if this is a reply to a daily nudge ---
  const nudgeResult = await matchNudge(candidates);
  if (nudgeResult) {
    await handleNudgeReply(nudgeResult, replyBody, incomingMessageId);
    return new Response('OK', { status: 200 });
  }

  // --- Route 2: Check if this is a reply to a plan proposal ---
  const proposalResult = await matchProposal(candidates);
  if (proposalResult) {
    await handleProposalReply(proposalResult, replyBody, incomingMessageId);
    return new Response('OK', { status: 200 });
  }

  // --- Route 3: Workout feedback reply (existing flow) ---
  let workout: any = null;
  for (const msgId of candidates) {
    const { data } = await supabase.from('workouts').select('*').eq('email_message_id', msgId).single();
    if (data) { workout = data; break; }
  }

  if (!workout) {
    console.log(`[on-reply] No match for any of: ${candidates.join(', ')}`);
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
    const context     = sessionData.context ?? '';

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

    // Generate coaching report with enriched context
    const coachingReport = await callAnthropic(
      anthropicKey,
      buildCoachingPrompt(workout, athlete, session, replyBody, complianceScore, context),
      600
    );

    // Send coaching report as threaded reply — keep same subject for threading
    const reportResult = await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `Re: [CoachCarter] ${workout.day_of_week} ${workout.sport} — feedback needed`,
      text: coachingReport,
      replyToMessageId: incomingMessageId ?? locked.email_message_id ?? inReplyTo,
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

    // --- Evaluate feedback against Plan Stability Doctrine ---
    if (context) {
      try {
        const triggerResult = await callAnthropic(anthropicKey, buildTriggerEvalPrompt(replyBody, context), 200);
        const triggerParsed = JSON.parse(triggerResult.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());

        if (triggerParsed.triggered) {
          console.log(`[on-reply] Plan Stability trigger fired: ${triggerParsed.trigger} — ${triggerParsed.reasoning}`);

          // Generate proposal — pass coaching report for consistency
          const proposalText = await callAnthropic(
            anthropicKey,
            buildProposalPrompt(triggerParsed.trigger, replyBody, context, coachingReport),
            1000
          );

          // Consistency gate: check for factual contradictions only (not plan opinions)
          const consistencyCheck = await callAnthropic(
            anthropicKey,
            `A coaching report and a plan proposal were generated from the same athlete feedback. Check for FACTUAL contradictions only.\n\nCOACHING REPORT:\n"${coachingReport}"\n\nPLAN PROPOSAL:\n"${proposalText}"\n\nOnly flag as inconsistent if they state opposite FACTS — e.g., "power was on target" vs "power was below target", or "sleep was fine" vs "sleep was poor". Differences in plan-level recommendations (keep vs remove an exercise) are NOT contradictions — the coaching report covers session feedback while the proposal covers plan changes. These are separate concerns.\n\nReturn JSON only:\n{"consistent": true/false, "contradiction": "brief description or null"}`,
            150
          );
          const consistency = JSON.parse(consistencyCheck.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());

          if (!consistency.consistent) {
            console.log(`[on-reply] Proposal suppressed — contradicts coaching report: ${consistency.contradiction}`);
          } else {
            // Send proposal email in same thread
            const proposalEmail = await sendViaAgentMail(agentmailKey, agentmailInbox, {
              to: athleteEmail,
              subject: `Re: [CoachCarter] ${workout.day_of_week} ${workout.sport} — feedback needed`,
              text: proposalText,
              replyToMessageId: incomingMessageId,
            });

            // Store proposal
            await supabase.from('plan_proposals').insert({
              source: 'feedback',
              source_workout_id: workout.id,
              plan_week: workout.plan_week,
              status: 'proposed',
              proposal_text: proposalText,
              email_message_id: proposalEmail?.message_id ?? null,
            });
          }
        }
      } catch (err) {
        // Non-fatal — coaching report already sent
        console.error('[on-reply] Trigger evaluation failed (non-fatal):', err);
      }
    }

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('[on-reply] Error:', err);
    // Reset so next Svix retry can proceed
    await supabase.from('workouts').update({ status: 'awaiting_feedback' }).eq('id', workout.id);
    return new Response('Internal error', { status: 500 });
  }
});

// --- Nudge reply handling ---

async function matchNudge(candidates: string[]): Promise<any | null> {
  for (const msgId of candidates) {
    const { data } = await supabase.from('daily_nudges')
      .select('*').eq('email_message_id', msgId).is('response', null).limit(1).single();
    if (data) return data;
  }
  return null;
}

async function handleNudgeReply(nudge: any, replyBody: string, incomingMessageId: string) {
  // Update all nudge rows sharing the same email_message_id (one email may cover multiple sessions)
  await supabase.from('daily_nudges')
    .update({ response: replyBody, response_at: new Date().toISOString() })
    .eq('email_message_id', nudge.email_message_id);

  console.log(`[on-reply] Nudge reply recorded for ${nudge.date} — "${replyBody.slice(0, 80)}"`);

  // Send brief acknowledgment
  const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')!;
  const agentmailKey   = Deno.env.get('AGENTMAIL_API_KEY')!;
  const agentmailInbox = Deno.env.get('AGENTMAIL_INBOX')!;
  const athleteEmail   = Deno.env.get('ATHLETE_EMAIL')!;

  const ack = await callAnthropic(
    anthropicKey,
    `You are a triathlon coach. The athlete replied to a missed-workout check-in with: "${replyBody}". Write a brief 1-2 sentence acknowledgment. Be warm but direct. If they gave a reason, acknowledge it. If they plan to make it up, encourage that. No headers, no fluff.`,
    150
  );

  await sendViaAgentMail(agentmailKey, agentmailInbox, {
    to: athleteEmail,
    subject: `Re: [CoachCarter] Missed ${nudge.date} — checking in`,
    text: ack,
    replyToMessageId: incomingMessageId,
  });
}

// --- Proposal reply handling ---

async function matchProposal(candidates: string[]): Promise<any | null> {
  for (const msgId of candidates) {
    const { data } = await supabase.from('plan_proposals')
      .select('*').eq('email_message_id', msgId).eq('status', 'proposed').limit(1).single();
    if (data) return data;
  }
  return null;
}

async function handleProposalReply(proposal: any, replyBody: string, incomingMessageId: string) {
  const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')!;
  const agentmailKey   = Deno.env.get('AGENTMAIL_API_KEY')!;
  const agentmailInbox = Deno.env.get('AGENTMAIL_INBOX')!;
  const athleteEmail   = Deno.env.get('ATHLETE_EMAIL')!;

  // Classify the response
  const classResult = await callAnthropic(
    anthropicKey,
    `Classify this athlete's reply to a plan change proposal. Reply: "${replyBody}"\n\nReturn JSON only: {"decision": "accept|reject|modify", "summary": "brief description"}`,
    100
  );
  const parsed = JSON.parse(classResult.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());

  if (parsed.decision === 'accept') {
    await supabase.from('plan_proposals').update({
      status: 'approved',
      athlete_response: replyBody,
      resolved_at: new Date().toISOString(),
    }).eq('id', proposal.id);

    await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `Re: [CoachCarter] Week ${proposal.plan_week} plan review — proposed adjustment`,
      text: `Got it — plan changes approved. I'll update plan.json accordingly. You'll see the updated plan reflected in your next coaching email.`,
      replyToMessageId: incomingMessageId,
    });

    console.log(`[on-reply] Proposal ${proposal.id} accepted`);

  } else if (parsed.decision === 'reject') {
    await supabase.from('plan_proposals').update({
      status: 'rejected',
      athlete_response: replyBody,
      resolved_at: new Date().toISOString(),
    }).eq('id', proposal.id);

    await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `Re: [CoachCarter] Week ${proposal.plan_week} plan review — proposed adjustment`,
      text: `Understood — keeping the plan unchanged. Let me know if anything changes.`,
      replyToMessageId: incomingMessageId,
    });

    console.log(`[on-reply] Proposal ${proposal.id} rejected`);

  } else {
    // Athlete wants modifications — generate revised proposal
    const revisedText = await callAnthropic(
      anthropicKey,
      `You are a triathlon coach. The athlete received this plan proposal:\n\n${proposal.proposal_text}\n\nThey replied: "${replyBody}"\n\nGenerate a revised proposal incorporating their feedback. Follow the same format:\n1. What's changing and why\n2. Full week view (before and after)\n3. Constraint check\n4. Reversibility\n\nEnd with: "Reply YES to approve, NO to decline, or suggest an alternative."`,
      1000
    );

    // Mark original as revised
    await supabase.from('plan_proposals').update({
      status: 'revised',
      athlete_response: replyBody,
      resolved_at: new Date().toISOString(),
    }).eq('id', proposal.id);

    // Send revised proposal
    const revisedEmail = await sendViaAgentMail(agentmailKey, agentmailInbox, {
      to: athleteEmail,
      subject: `Re: [CoachCarter] Week ${proposal.plan_week} plan review — proposed adjustment`,
      text: revisedText,
      replyToMessageId: incomingMessageId,
    });

    // Insert new proposal row
    await supabase.from('plan_proposals').insert({
      source: proposal.source,
      source_workout_id: proposal.source_workout_id,
      plan_week: proposal.plan_week,
      status: 'proposed',
      proposal_text: revisedText,
      revision_of: proposal.id,
      email_message_id: revisedEmail?.message_id ?? null,
    });

    console.log(`[on-reply] Proposal ${proposal.id} revised, new proposal created`);
  }
}

// --- Shared helpers ---

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
  // Use Reply endpoint when threading, Send endpoint for new conversations
  if (replyToMessageId) {
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) throw new Error(`AgentMail reply error ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, text }),
  });
  if (!res.ok) throw new Error(`AgentMail error ${res.status}: ${await res.text()}`);
  return await res.json();
}

const PLAN_STABILITY_DOCTRINE = `
PLAN STABILITY DOCTRINE:
Only THREE triggers justify a plan change:
1. EXPLICIT ATHLETE REQUEST
2. STRUCTURAL IMPOSSIBILITY (permanent, not one-off)
3. SUSTAINED PATTERN OVER 3+ WEEKS
Everything else gets a coaching note only.
If compliance > 70%, do NOT propose structural changes.
Every proposal must answer: "Why is this a plan problem and not an execution problem?"
`.trim();

function buildTriggerEvalPrompt(feedback: string, context: string): string {
  return `${PLAN_STABILITY_DOCTRINE}

${context}

Athlete feedback:
"${feedback}"

Evaluate this feedback against the Plan Stability Doctrine. Does it meet ANY of the three triggers?

IMPORTANT — these are NOT triggers:
- Questions about exercises ("what is X?", "is X useful?") → coaching note, not a trigger
- Expressing preferences ("I prefer reps over minutes") → coaching note unless it makes the current plan impossible
- Reporting difficulty ("X feels extreme", "Y is hard") → coaching note, difficulty is expected
- Feedback about a single session → coaching note, one session is never a pattern
- Describing what they did differently ("did X with dumbbells") → coaching note, this is execution info

Only return triggered:true if the feedback contains an UNAMBIGUOUS, DIRECT request to change the plan, describes a PERMANENT structural barrier, or the rolling window shows 3+ weeks of the SAME problem.

Default to triggered:false. When in doubt, it's not a trigger.

Return JSON only:
{"triggered": true/false, "trigger": "trigger_1|trigger_2|trigger_3|none", "reasoning": "brief explanation"}`;
}

function buildProposalPrompt(trigger: string, feedback: string, context: string, coachingReport: string): string {
  return `You are a triathlon coach. Be direct and data-led.

${PLAN_STABILITY_DOCTRINE}

${context}

A Plan Stability Doctrine trigger has fired: ${trigger}
Athlete feedback: "${feedback}"

IMPORTANT — You already sent this coaching report to the athlete moments ago:
"${coachingReport}"

Your proposal MUST be consistent with the coaching report above. Do not contradict advice you just gave. If the coaching report recommended keeping an exercise, do not propose removing it.

Generate a plan change proposal. Be concise — say what needs to be said, nothing more. Use bullet points, not tables. No pipe characters or ASCII tables — this is a plain-text email.

Cover:
- What's changing and why
- Why this is a plan problem, not an execution problem
- Any tradeoffs
- When to re-evaluate

End with: "Reply YES to approve, NO to decline, or suggest an alternative."`;
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
  complianceScore: number | null,
  context: string
): string {
  const athleteCtx = `Athlete: FTP ${athlete.ftp ?? '?'}W, LTHR ${athlete.lthr ?? '?'}bpm, run threshold ${athlete.run_threshold_sec_per_km ?? '?'}s/km, swim CSS ${athlete.swim_css_sec_per_100m ?? '?'}s/100m.`;
  const workoutCtx = [
    `${workout.day_of_week} ${workout.sport} — ${workout.date}`,
    `Session: ${session?.id || 'unplanned'} (${session?.type || 'n/a'})`,
    `Duration: ${workout.duration_min}min | Calories: ${workout.calories ?? '—'}`,
    workout.sport === 'bike' ? `NP: ${workout.normalized_power}W | VI: ${workout.variability_index} | TSS: ${workout.tss} | Intervals: ${workout.intervals_detected?.work_intervals}/${session?.targets?.main_set?.sets}` : '',
    workout.sport === 'run'  ? `Avg pace: ${workout.avg_pace_sec}s/km | Avg HR: ${workout.avg_hr}bpm` : '',
    workout.sport === 'swim' ? `Distance: ${workout.distance_km ? Math.round(workout.distance_km * 1000) : '—'}m | Avg pace: ${workout.avg_pace_sec ?? '—'}s/100m` : '',
    `Compliance: ${complianceScore ?? 'N/A'}`,
    `Targets: ${JSON.stringify(session?.targets ?? {})}`,
    `Coaching notes: ${session?.coaching_notes ?? 'none'}`,
    `Athlete feedback: ${feedback}`,
  ].filter(Boolean).join('\n');

  const contextBlock = context ? `\n\n${context}\n` : '';

  return `You are a triathlon coach. Be direct and data-led. Lead with numbers. Coach, not cheerleader.

${athleteCtx}
${contextBlock}
${workoutCtx}

Write a short, direct coaching note — 4–6 sentences max, no headers, no fluff.
Lead with the key numbers and what they mean. Call out 1–2 high-impact actionables for next time. Be blunt.
Do NOT comment on whether exercises should be kept or removed from the plan. Stick to session feedback only — what happened, how it went, what to focus on next time.
If the athlete requests a plan change or raises a concern, acknowledge it and say it will be addressed separately.${complianceScore != null && complianceScore < 70 ? ' Include one concrete plan adjustment.' : ''}`;
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
