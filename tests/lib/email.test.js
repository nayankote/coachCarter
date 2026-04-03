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
    'https://api.agentmail.to/v0/inboxes/coachcarter/messages/send',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-agentmail-key' }),
    })
  );
  expect(result.messageId).toBe('<abc123@mail.agentmail.to>');
});

test('uses Reply endpoint when threading', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ message_id: '<reply@mail.agentmail.to>' }),
  });

  const { sendFeedbackEmail } = require('../../lib/email');
  await sendFeedbackEmail({
    to: 'athlete@example.com',
    subject: 'Re: test',
    body: 'Report body',
    replyToMessageId: 'msg-uuid-123',
  });

  expect(mockFetch).toHaveBeenCalledWith(
    'https://api.agentmail.to/v0/inboxes/coachcarter/messages/msg-uuid-123/reply',
    expect.objectContaining({ method: 'POST' })
  );
  const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(sentBody.text).toBe('Report body');
  expect(sentBody.subject).toBeUndefined();
});

test('throws on AgentMail API error', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

  const { sendFeedbackEmail } = require('../../lib/email');
  await expect(
    sendFeedbackEmail({ to: 'x', subject: 'x', body: 'x' })
  ).rejects.toThrow('AgentMail send failed (401)');
});
