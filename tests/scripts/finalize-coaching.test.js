jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/coaching');
jest.mock('../../lib/email');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, matchSession } = require('../../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../../lib/coaching');
const { sendFeedbackEmail } = require('../../lib/email');

const mockWorkout = {
  id: 'uuid-456',
  sport: 'bike',
  day_of_week: 'Wednesday',
  plan_week: 1,
  compliance_score: 85,
  compliance_breakdown: {},
  email_message_id: '<original@mail.agentmail.to>',
  feedback: 'Felt great, hit all intervals',
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ATHLETE_EMAIL = 'athlete@example.com';
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({ plan_start_date: '2026-03-17', athlete: { ftp: 190 }, weeks: [] });
  matchSession.mockReturnValue(null);
  generateCoachingReport.mockResolvedValue('Great ride. Threshold power was spot on...');
  sendFeedbackEmail.mockResolvedValue({ messageId: '<report@mail.agentmail.to>' });
});

test('sends final coaching report email to athlete', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(sendFeedbackEmail).toHaveBeenCalledWith(
    expect.objectContaining({ body: 'Great ride. Threshold power was spot on...' })
  );
});

test('threads final report as reply to original coaching email', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(sendFeedbackEmail).toHaveBeenCalledWith(
    expect.objectContaining({ replyToMessageId: '<original@mail.agentmail.to>' })
  );
});

test('marks workout complete after sending report', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(mockDb.update).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'complete' })
  );
});

test('extracts strength compliance from reply for strength workouts', async () => {
  mockDb.single.mockResolvedValue({ data: { ...mockWorkout, sport: 'strength' } });
  matchSession.mockReturnValue({ id: 'strength_session', type: 'strength', targets: {} });
  generateStrengthCompliance.mockResolvedValue({ compliance_score: 90, exercises_completed: [] });

  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateStrengthCompliance).toHaveBeenCalled();
});
