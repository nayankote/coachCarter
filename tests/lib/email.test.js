jest.mock('nodemailer');
jest.mock('imapflow');
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('app-password') }));

process.env.COACHCARTER_EMAIL = 'coachcarter@gmail.com';

const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

const mockTransporter = { sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@gmail.com>' }) };
nodemailer.createTransport.mockReturnValue(mockTransporter);

const { sendFeedbackEmail, pollReplies } = require('../../lib/email');

test('sendFeedbackEmail uses Gmail SMTP with Keychain App Password', async () => {
  await sendFeedbackEmail({ to: 'nayan@example.com', subject: 'Test', body: 'Hello' });
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
    host: 'smtp.gmail.com',
    auth: expect.objectContaining({ user: 'coachcarter@gmail.com', pass: 'app-password' }),
  }));
});

test('sendFeedbackEmail returns the SMTP message_id', async () => {
  const result = await sendFeedbackEmail({ to: 'nayan@example.com', subject: 'Test', body: 'Hello' });
  expect(result.messageId).toBe('<abc@gmail.com>');
});

test('pollReplies connects via IMAP with CoachCarter credentials', async () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    mailboxOpen: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  ImapFlow.mockImplementation(() => mockClient);

  await pollReplies({ onReply: jest.fn() });
  expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({
    host: 'imap.gmail.com',
    auth: expect.objectContaining({ user: 'coachcarter@gmail.com', pass: 'app-password' }),
  }));
  expect(mockClient.connect).toHaveBeenCalled();
});

test('pollReplies calls onReply with inReplyTo and body when messages found', async () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    mailboxOpen: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([42]),
    fetchOne: jest.fn().mockResolvedValue({
      envelope: { messageId: '<reply@gmail.com>', inReplyTo: '<original@gmail.com>' },
      source: Buffer.from('Great session, 8/10.'),
    }),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  ImapFlow.mockImplementation(() => mockClient);

  const onReply = jest.fn().mockResolvedValue(undefined);
  await pollReplies({ onReply });

  expect(onReply).toHaveBeenCalledWith(expect.objectContaining({
    inReplyTo: '<original@gmail.com>',
    body: expect.stringContaining('Great session'),
  }));
  expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith(42, ['\\Seen']);
});
