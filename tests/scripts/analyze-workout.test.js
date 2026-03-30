// tests/scripts/analyze-workout.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/fit-parser');
jest.mock('../../lib/plan');
jest.mock('../../lib/compliance');
jest.mock('../../lib/email');
jest.mock('../../lib/email-templates');

const { getSupabase } = require('../../lib/supabase');
const { extractMetrics } = require('../../lib/fit-parser');
const { loadPlan, calcPlanWeek, matchSession } = require('../../lib/plan');
const { scoreCompliance } = require('../../lib/compliance');
const { sendFeedbackEmail } = require('../../lib/email');
const { buildEmailBody } = require('../../lib/email-templates');

const mockWorkout = {
  id: 'uuid-123', garmin_activity_id: 999, sport: 'bike',
  date: '2026-03-18', day_of_week: 'Wednesday',
  fit_file_path: 'fit-files/2026-03-18_bike_999.fit', status: 'synced',
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
  storage: { from: jest.fn().mockReturnThis(), download: jest.fn().mockResolvedValue({ data: { arrayBuffer: async () => Buffer.from('fit') } }) },
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  extractMetrics.mockResolvedValue({ duration_min: 60, avg_power: 175, normalized_power: 178 });
  loadPlan.mockReturnValue({ plan_start_date: '2026-03-17', athlete: { ftp: 190 }, weeks: [] });
  calcPlanWeek.mockReturnValue(1);
  matchSession.mockReturnValue(null);
  scoreCompliance.mockReturnValue({ score: null, breakdown: {} });
  sendFeedbackEmail.mockResolvedValue({ messageId: '<msg@gmail.com>' });
  buildEmailBody.mockReturnValue('Bike email body');
});

test('updates status to analyzing then awaiting_feedback', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  const calls = mockDb.update.mock.calls.map(c => c[0]);
  expect(calls.some(c => c.status === 'analyzing')).toBe(true);
  expect(calls.some(c => c.status === 'awaiting_feedback')).toBe(true);
});

test('passes plan.athlete to extractMetrics', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(extractMetrics).toHaveBeenCalledWith(
    expect.anything(),
    'bike',
    { ftp: 190 },
    expect.any(Number)
  );
});

test('stores email_message_id after sending', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ email_message_id: '<msg@gmail.com>' }));
});

test('tags unmatched activity as unplanned', async () => {
  const { run } = require('../../scripts/analyze-workout');
  await run('uuid-123');
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({ plan_session_id: 'unplanned' }));
});
