jest.mock('../../lib/supabase');
jest.mock('../../lib/plan');
jest.mock('../../lib/compliance');
jest.mock('../../lib/coaching');

const { getSupabase } = require('../../lib/supabase');
const { loadPlan, matchSession } = require('../../lib/plan');
const { generateCoachingReport, generateStrengthCompliance } = require('../../lib/coaching');

const mockWorkout = {
  id: 'uuid-456', sport: 'bike', date: '2026-03-18',
  day_of_week: 'Wednesday', plan_week: 1, plan_session_id: 'wed_bike',
  feedback: 'Great. 8/10.', compliance_score: 80,
  normalized_power: 175, duration_min: 58,
};

const mockDb = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data: mockWorkout }),
  update: jest.fn().mockReturnThis(),
};

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  loadPlan.mockReturnValue({ athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 }, weeks: [] });
  matchSession.mockReturnValue({ id: 'wed_bike', type: 'intervals', targets: {}, coaching_notes: '' });
  generateCoachingReport.mockResolvedValue('Solid session this week...');
  generateStrengthCompliance.mockResolvedValue({ compliance_score: 85 });
});

test('generates coaching report and saves it with status = complete', async () => {
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateCoachingReport).toHaveBeenCalledWith(expect.objectContaining({
    workout: expect.objectContaining({ id: 'uuid-456' }),
    feedback: 'Great. 8/10.',
    plan: expect.objectContaining({ athlete: expect.objectContaining({ ftp: 190 }) }),
  }));
  expect(mockDb.update).toHaveBeenCalledWith(expect.objectContaining({
    coaching_report: 'Solid session this week...',
    status: 'complete',
  }));
});

test('for strength: calls generateStrengthCompliance to compute score from reply', async () => {
  mockDb.single.mockResolvedValue({ data: { ...mockWorkout, sport: 'strength', compliance_score: null } });
  const { run } = require('../../scripts/finalize-coaching');
  await run('uuid-456');
  expect(generateStrengthCompliance).toHaveBeenCalledWith(expect.objectContaining({
    session: expect.objectContaining({ id: 'wed_bike' }),
    feedback: 'Great. 8/10.',
  }));
});
