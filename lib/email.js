// lib/email.js
const { getSecret } = require('./keychain');

async function sendFeedbackEmail({ to, subject, body, replyToMessageId = null }) {
  const apiKey = getSecret('coachcarter-agentmail');
  const inbox = process.env.AGENTMAIL_INBOX;

  // Use the Reply endpoint when threading, Send endpoint for new conversations
  if (replyToMessageId) {
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, text: body }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AgentMail reply failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return { messageId: data.message_id };
  }

  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, subject, text: body }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentMail send failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return { messageId: data.message_id };
}

module.exports = { sendFeedbackEmail };
