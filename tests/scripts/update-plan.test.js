const { validatePlan } = require('../../scripts/update-plan');

test('valid plan returns no errors', () => {
  const plan = {
    plan_start_date: '2026-03-17',
    athlete: { ftp: 190 },
    weeks: [{ week: 1, sessions: [{ id: 'mon_bike', day: 'Monday', sport: 'bike' }] }],
  };
  expect(validatePlan(plan)).toHaveLength(0);
});

test('missing plan_start_date returns an error', () => {
  expect(validatePlan({ athlete: { ftp: 190 }, weeks: [] })).toContain('plan_start_date is required');
});

test('missing ftp returns an error', () => {
  expect(validatePlan({ plan_start_date: '2026-03-17', athlete: {}, weeks: [] })).toContain('athlete.ftp is required');
});

test('session missing id returns an error', () => {
  const plan = {
    plan_start_date: '2026-03-17', athlete: { ftp: 190 },
    weeks: [{ week: 1, sessions: [{ day: 'Monday', sport: 'bike' }] }],
  };
  expect(validatePlan(plan)).toContain('session.id is required');
});
