// lib/email.js
const { getSecret } = require('./keychain');

async function sendFeedbackEmail({ to, subject, body, replyToMessageId = null }) {
  const apiKey = getSecret('coachcarter-agentmail');
  const inbox = process.env.AGENTMAIL_INBOX;

  const payload = {
    to,
    subject,
    text: body,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
  };

  // IMPORTANT: verify at setup that AgentMail returns RFC 2822 message_id
  // (e.g. <abc@mail.agentmail.to>) not an internal UUID — this value gets
  // stored in workouts.email_message_id and matched against In-Reply-To headers
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentMail send failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return { messageId: data.message_id };
}

// pollReplies: deprecated — replaced by AgentMail webhook → on-reply Edge Function
// Left here to avoid breaking imports during migration. Remove after verification.
async function pollReplies() {
  console.warn('[email] pollReplies is deprecated — replies are now handled by the on-reply Edge Function');
  return 0;
}

module.exports = { sendFeedbackEmail, pollReplies };
