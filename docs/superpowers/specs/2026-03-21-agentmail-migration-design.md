# AgentMail Migration Design

## Goal
Replace Gmail SMTP + IMAP polling with AgentMail — a purpose-built AI agent email service. All email sending moves to the AgentMail HTTP API. Reply detection moves from polling to an event-driven Supabase Edge Function webhook receiver.

## Architecture

### Current
- Send: nodemailer → Gmail SMTP (requires Gmail app password)
- Receive: imapflow polling Gmail IMAP (only runs when sync-garmin runs)
- Finalize: local script triggered by poll — **known gap: never sends final coaching report back to athlete**

### New
- Send: AgentMail HTTP API (all emails — workout feedback, final report, weekly review)
- Receive: AgentMail webhook → Supabase Edge Function (fires immediately on reply)
- Finalize: Edge Function inline — fixes the email gap by sending final coaching report

```
analyze-workout / weekly-review
  → lib/email.js (AgentMail API)
  → coachcarter@agentmail.to → athlete inbox

Athlete replies
  → AgentMail fires webhook immediately
  → supabase/functions/on-reply
  → Anthropic API (compliance extraction + coaching report)
  → AgentMail API (send final coaching report to athlete)  ← fixes current gap
  → Supabase workout marked complete
```

## Components

### 1. `lib/email.js`
`sendFeedbackEmail` keeps the same interface — all callers unchanged:

```js
async function sendFeedbackEmail({ to, subject, body, replyToMessageId? })
```

Internals: POST to AgentMail API instead of nodemailer SMTP.
- `Authorization: Bearer AGENTMAIL_API_KEY`
- Returns the RFC 2822 `Message-ID` from the AgentMail response (used for threading)
- Optional `replyToMessageId`: when set, threads the email as a reply in the athlete's inbox

**Note:** AgentMail's send response must return the RFC 2822 `Message-ID` (not an internal UUID) for webhook matching to work. Verify this against AgentMail docs at implementation time.

`pollReplies` — left in file, not called anywhere. Deleted in final cleanup.

### 2. `supabase/functions/on-reply/index.ts`
Deno Edge Function. Receives AgentMail webhook POST on every inbound reply.

**Webhook payload — verify exact shape against AgentMail docs at implementation time:**
```json
{
  "message_id": "<new-msg-id>",
  "in_reply_to": "<original-coaching-email-id>",
  "from": "nayankt76@gmail.com",
  "subject": "Re: [CoachCarter] Wednesday Bike...",
  "text": "Felt strong, completed all intervals...",
  "html": "<p>Felt strong...</p>"
}
```
- `in_reply_to` may be nested under `headers` in the actual payload — confirm at implementation
- `html` field: use `text` if present, fall back to stripping HTML tags from `html`
- Webhook authentication: verify AgentMail signature header (shared secret or HMAC) — reject requests that fail verification with 401

**Logic:**
1. Verify webhook signature → 401 if invalid
2. Set workout status to `processing` atomically — if already `processing` or `complete`, return 200 immediately (prevents double-fire race condition)
3. Extract reply body (`text` or stripped `html`)
4. Match `in_reply_to` → `workouts.email_message_id` to find workout
5. If no match → return 200 (ignore, may be a non-coaching reply)
6. If `sport === 'strength'` → raw fetch to Anthropic API to extract structured compliance
7. Raw fetch to Anthropic API to generate coaching report
8. Send final coaching report to athlete via AgentMail API (threaded as reply using `replyToMessageId`)
9. Update workout: `status = 'complete'`, `compliance_score`, `compliance_breakdown`, `coaching_report`
10. On any Anthropic API failure → reset workout status back to `awaiting_feedback`, then return 500 (triggers AgentMail webhook retry; resetting status ensures the step 2 guard lets the retry through)

**Anthropic calls:** Raw `fetch` to `api.anthropic.com/v1/messages` — same prompts, same model (`claude-sonnet-4-6`), no SDK needed in Deno.

**Secrets (Supabase Edge Function environment):**
- `ANTHROPIC_API_KEY`
- `AGENTMAIL_API_KEY`
- `AGENTMAIL_INBOX`
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected on the same Supabase project — no manual setup needed

### 3. `scripts/finalize-coaching.js`
**Also updated** to send the final coaching report email (fixing the existing gap where it only stored the report in Supabase). Kept for manual retries when webhook fails or workout is stuck at `awaiting_feedback`.

## Migration Strategy
Graceful — AgentMail is built alongside Gmail. Only after end-to-end verification:
1. Verify a full cycle works: workout synced → coaching email sent → reply received → final report emailed → workout complete
2. Remove nodemailer, imapflow from `package.json`
3. Delete `pollReplies` from `lib/email.js`
4. Remove `coachcarter-gmail` from keychain and GitHub secrets
5. Update `COACHCARTER_EMAIL` in `.env` from `nayankote.work@gmail.com` to `coachcarter@agentmail.to`

## AgentMail Setup (one-time, manual)
1. Create account at agentmail.to
2. Create inbox: `coachcarter` → `coachcarter@agentmail.to`
3. Set webhook URL: `https://<project-ref>.supabase.co/functions/v1/on-reply`
4. Configure webhook shared secret for signature verification
5. Copy API key

## Secrets
| Secret | Where |
|---|---|
| `AGENTMAIL_API_KEY` | macOS keychain (`coachcarter-agentmail`) + GitHub Actions secret + Supabase Edge Function secret |
| `AGENTMAIL_INBOX` | `.env` (not sensitive) |

`keychain.js` ENV_VAR_MAP gets: `'coachcarter-agentmail': 'AGENTMAIL_API_KEY'`

## Known Gap Fixed
`finalize-coaching.js` currently stores the coaching report in Supabase but never emails it to the athlete. This migration fixes that — both the Edge Function and the updated local script send the final coaching report.

## Out of Scope
- Context injection (previous workout history in prompts) — separate spec
- AgentMail inbox API polling — not needed, webhook handles replies
