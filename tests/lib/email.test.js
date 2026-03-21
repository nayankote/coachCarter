// tests/lib/email.test.js
jest.mock('../../lib/keychain', () => ({ getSecret: () => 'test-agentmail-key' }));

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  jest.resetModules();
  mockFetch.mockReset();
  process.env.AGENTMAIL_INBOX = 'coachcarter';
});

test('sends email via AgentMail API', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message_id: '<abc123@mail.agentmail.to>' }),
  });

  const { sendFeedbackEmail } = require('../../lib/email');
  const result = await sendFeedbackEmail({
    to: 'athlete@example.com',
    subject: 'Test subject',
    body: 'Test body',
  });

  expect(mockFetch).toHaveBeenCalledWith(
    'https://api.agentmail.to/v0/inboxes/coachcarter/messages',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-agentmail-key' }),
    })
  );
  expect(result.messageId).toBe('<abc123@mail.agentmail.to>');
});

test('includes reply_to_message_id when threading', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message_id: '<reply@mail.agentmail.to>' }),
  });

  const { sendFeedbackEmail } = require('../../lib/email');
  await sendFeedbackEmail({
    to: 'athlete@example.com',
    subject: 'Re: test',
    body: 'Report body',
    replyToMessageId: '<original@mail.agentmail.to>',
  });

  const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(sentBody.reply_to_message_id).toBe('<original@mail.agentmail.to>');
});

test('throws on AgentMail API error', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

  const { sendFeedbackEmail } = require('../../lib/email');
  await expect(
    sendFeedbackEmail({ to: 'x', subject: 'x', body: 'x' })
  ).rejects.toThrow('AgentMail send failed (401)');
});
