const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { getSecret } = require('./keychain');

function createTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.COACHCARTER_EMAIL,
      pass: getSecret('coachcarter-gmail'),
    },
  });
}

async function sendFeedbackEmail({ to, subject, body }) {
  const transport = createTransport();
  const result = await transport.sendMail({
    from: process.env.COACHCARTER_EMAIL,
    to,
    subject,
    text: body,
  });
  return { messageId: result.messageId };
}

// Polls the dedicated CoachCarter inbox for unseen messages.
// Calls onReply({ uid, messageId, inReplyTo, body }) for each message that has In-Reply-To set.
async function pollReplies({ onReply, sinceDate } = {}) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.COACHCARTER_EMAIL,
      pass: getSecret('coachcarter-gmail'),
    },
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  const since = sinceDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const uids = await client.search({ since, seen: false });

  for (const uid of uids) {
    const msg = await client.fetchOne(uid, { source: true, envelope: true });
    const inReplyTo = msg.envelope?.inReplyTo;
    const body = msg.source?.toString();
    if (inReplyTo && onReply) {
      await onReply({ uid, messageId: msg.envelope?.messageId, inReplyTo, body });
    }
    await client.messageFlagsAdd(uid, ['\\Seen']);
  }

  await client.logout();
  return uids.length;
}

module.exports = { sendFeedbackEmail, pollReplies };
