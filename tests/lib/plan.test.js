const path = require('path');
const fs = require('fs');

// Point to fixture to avoid coupling tests to the real plan.json
process.env.PLAN_PATH = path.join(__dirname, '../fixtures/plan.fixture.json');

const fixturePlan = {
  plan_start_date: '2026-03-17',
  athlete: { ftp: 190, run_threshold_sec_per_km: 290, swim_css_sec_per_100m: 180 },
  weeks: [{
    week: 1,
    sessions: [
      { id: 'mon_bike',     day: 'Monday',    sport: 'bike',     type: 'intervals' },
      { id: 'tue_strength', day: 'Tuesday',   sport: 'strength', type: 'A' },
      { id: 'wed_swim',     day: 'Wednesday', sport: 'swim',     type: 'technique' },
      { id: 'thu_strength', day: 'Thursday',  sport: 'strength', type: 'B' },
      { id: 'sat_bike',     day: 'Saturday',  sport: 'bike',     type: 'z2' },
      { id: 'sat_run',      day: 'Saturday',  sport: 'run',      type: 'z2' },
      { id: 'sun_swim',     day: 'Sunday',    sport: 'swim',     type: 'easy' },
      { id: 'sun_run',      day: 'Sunday',    sport: 'run',      type: 'z2' },
    ],
  }],
};

beforeAll(() => {
  const dir = path.join(__dirname, '../fixtures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(process.env.PLAN_PATH, JSON.stringify(fixturePlan));
});

const { loadPlan, calcPlanWeek, matchSession } = require('../../lib/plan');

test('loadPlan returns parsed plan object', () => {
  const plan = loadPlan();
  expect(plan.plan_start_date).toBe('2026-03-17');
  expect(plan.weeks).toHaveLength(1);
});

test('calcPlanWeek returns 1 for the first week', () => {
  expect(calcPlanWeek('2026-03-17', '2026-03-17')).toBe(1);
  expect(calcPlanWeek('2026-03-17', '2026-03-23')).toBe(1);
});

test('calcPlanWeek cycles: week 4 rolls over to week 1', () => {
  expect(calcPlanWeek('2026-03-17', '2026-04-13')).toBe(4);
  expect(calcPlanWeek('2026-03-17', '2026-04-14')).toBe(1);
});

test('matchSession returns matching session for day+sport', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Monday', 'bike').id).toBe('mon_bike');
});

test('matchSession returns null for unplanned activity', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Friday', 'run')).toBeNull();
});

test('matchSession distinguishes same-day sessions by sport', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Saturday', 'bike').id).toBe('sat_bike');
  expect(matchSession(plan, 1, 'Saturday', 'run').id).toBe('sat_run');
});

test('matchSession matches strength sessions by day', () => {
  const plan = loadPlan();
  expect(matchSession(plan, 1, 'Tuesday', 'strength').id).toBe('tue_strength');
  expect(matchSession(plan, 1, 'Thursday', 'strength').id).toBe('thu_strength');
});
