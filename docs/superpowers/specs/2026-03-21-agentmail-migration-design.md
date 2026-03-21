# AgentMail Migration Design

## Goal
Replace Gmail SMTP + IMAP polling with AgentMail — a purpose-built AI agent email service. All email sending moves to the AgentMail HTTP API. Reply detection moves from polling to an event-driven Supabase Edge Function webhook receiver.

## Architecture

### Current
- Send: nodemailer → Gmail SMTP (requires Gmail app password)
- Receive: imapflow polling Gmail IMAP (only runs when sync-garmin runs)
- Finalize: local script triggered by poll

### New
- Send: AgentMail HTTP API (all emails — workout feedback, final report, weekly review)
- Receive: AgentMail webhook → Supabase Edge Function (fires immediately on reply)
- Finalize: Edge Function inline, local script kept for manual retries

```
analyze-workout / weekly-review
  → lib/email.js (AgentMail API)
  → coachcarter@agentmail.to → athlete inbox

Athlete replies
  → AgentMail fires webhook immediately
  → supabase/functions/on-reply
  → Anthropic API (compliance extraction + coaching report)
  → AgentMail API (send final report)
  → Supabase workout marked complete
```

## Components

### 1. `lib/email.js`
- `sendFeedbackEmail({ to, subject, body, replyToMessageId? })` — same interface, new internals
  - POST `https://api.agentmail.to/v0/inboxes/{username}/messages`
  - `Authorization: Bearer AGENTMAIL_API_KEY`
  - Returns `messageId` from AgentMail response
  - Optional `replyToMessageId` threads replies correctly in athlete's inbox
- `pollReplies` — deprecated in place, not called anywhere. Deleted in final cleanup.

### 2. `supabase/functions/on-reply/index.ts`
Deno Edge Function. Receives AgentMail webhook POST on every inbound reply.

**Webhook payload (AgentMail):**
```json
{
  "message_id": "<new-msg-id>",
  "in_reply_to": "<original-coaching-email-id>",
  "from": "nayankt76@gmail.com",
  "subject": "Re: [CoachCarter] Wednesday Bike...",
  "text": "Felt strong, completed all intervals..."
}
```

**Logic:**
1. Match `in_reply_to` → `workouts.email_message_id`
2. If no match or workout already `complete` → return 200 (idempotent)
3. If `sport === 'strength'` → raw fetch to Anthropic API to extract structured compliance
4. Raw fetch to Anthropic API to generate coaching report
5. Send final report via AgentMail API
6. Update workout: `status = 'complete'`, `compliance_score`, `coaching_report`

**Anthropic calls:** Raw `fetch` to `api.anthropic.com/v1/messages` — same prompts and model as `lib/coaching.js`, no SDK needed in Deno.

**Secrets (Supabase Edge Function environment):**
- `ANTHROPIC_API_KEY`
- `AGENTMAIL_API_KEY`
- `AGENTMAIL_INBOX`

### 3. `scripts/finalize-coaching.js`
Kept as-is for manual retries. If a webhook fails or a workout gets stuck at `awaiting_feedback`, this can be run locally to process it.

## Migration Strategy
Graceful — AgentMail is built alongside Gmail. Only after end-to-end verification:
- Remove nodemailer, imapflow from `package.json`
- Delete `pollReplies` from `lib/email.js`
- Remove `coachcarter-gmail` from keychain and GitHub secrets
- Update `COACHCARTER_EMAIL` in `.env` from `nayankote.work@gmail.com` to `coachcarter@agentmail.to`

## AgentMail Setup (one-time, manual)
1. Create account at agentmail.to
2. Create inbox: `coachcarter` → `coachcarter@agentmail.to`
3. Set webhook URL: `https://<project-ref>.supabase.co/functions/v1/on-reply`
4. Copy API key

## Secrets
| Secret | Where |
|---|---|
| `AGENTMAIL_API_KEY` | macOS keychain (`coachcarter-agentmail`) + GitHub Actions secret |
| `AGENTMAIL_INBOX` | `.env` (not sensitive) |

`keychain.js` ENV_VAR_MAP gets: `'coachcarter-agentmail': 'AGENTMAIL_API_KEY'`

## Out of Scope
- Context injection (previous workout history in prompts) — separate spec
- AgentMail inbox API polling — not needed, webhook handles replies
