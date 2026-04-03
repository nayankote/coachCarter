// tests/scripts/weekly-review.test.js
jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/coaching');
jest.mock('../../lib/email');
jest.mock('../../lib/athlete-context');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, calcPlanWeek } = require('../../lib/plan');
const { generateWeeklyReport } = require('../../lib/coaching');
const { sendFeedbackEmail } = require('../../lib/email');
const { loadGlobalContext, buildRollingWindow, formatContextForPrompt } = require('../../lib/athlete-context');

const mockInsert = jest.fn().mockResolvedValue({ error: null });
const mockDb = {
  from: jest.fn().mockImplementation((table) => {
    if (table === 'weekly_summaries') return {
      insert: mockInsert,
      select: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [{ overall_compliance: 78 }] }),
    };
    return {
      select: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockResolvedValue({ data: [] }),
    };
  }),
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({
    plan_start_date: '2026-03-17',
    athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 },
    weeks: [{ week: 1, sessions: [{ id: 'mon_bike', day: 'Monday', sport: 'bike' }] }],
  });
  calcPlanWeek.mockReturnValue(1);
  generateWeeklyReport.mockResolvedValue('Good week overall.');
  sendFeedbackEmail.mockResolvedValue({ messageId: '<weekly@gmail.com>' });
  loadGlobalContext.mockReturnValue({ season_phase: 'offseason', sleep_baseline: { typical_score: 70, typical_hours: 7 } });
  buildRollingWindow.mockResolvedValue({ summary: { sleep: {} }, windowStart: '2026-03-01', windowEnd: '2026-03-28' });
  formatContextForPrompt.mockReturnValue('test context');
});

test('queries workouts table for the current week', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('workouts');
});

test('sends weekly email and inserts into weekly_summaries', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(sendFeedbackEmail).toHaveBeenCalledWith(expect.objectContaining({
    subject: expect.stringContaining('Week 1 Review'),
    body: 'Good week overall.',
  }));
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
    plan_week: 1,
  }));
});

test('passes prior week compliance trend to generateWeeklyReport', async () => {
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(generateWeeklyReport).toHaveBeenCalledWith(
    expect.objectContaining({ priorWeekCompliance: 78 })
  );
});

test('passes priorWeekCompliance: null when no prior week data exists', async () => {
  mockDb.from.mockImplementation((table) => {
    if (table === 'weekly_summaries') return {
      insert: mockInsert,
      select: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({ data: [] }),
    };
    return {
      select: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    };
  });
  const { run } = require('../../scripts/weekly-review');
  await run();
  expect(generateWeeklyReport).toHaveBeenCalledWith(
    expect.objectContaining({ priorWeekCompliance: null })
  );
});
