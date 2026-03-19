jest.mock('@anthropic-ai/sdk');
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('sk-test') }));

const Anthropic = require('@anthropic-ai/sdk');
const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Great session! Keep it up.' }],
});
Anthropic.mockImplementation(() => ({ messages: { create: mockCreate } }));

const { generateCoachingReport } = require('../../lib/coaching');

test('calls Claude API with workout context and returns report text', async () => {
  const result = await generateCoachingReport({
    workout: { sport: 'bike', date: '2026-03-18', day_of_week: 'Wednesday', compliance_score: 85 },
    metrics: { normalized_power: 175, duration_min: 60 },
    session: { id: 'mon_bike', targets: {}, coaching_notes: '' },
    feedback: 'Felt strong. 8/10.',
    plan: { athlete: { ftp: 190, lthr: 165, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 } },
  });
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    model: expect.stringContaining('claude'),
    messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
  }));
  expect(result).toBe('Great session! Keep it up.');
});
