jest.mock('../../lib/garmin');
jest.mock('../../lib/supabase');
jest.mock('../../scripts/analyze-workout', () => ({ run: jest.fn().mockResolvedValue(undefined) }));

const garmin = require('../../lib/garmin');
const { getSupabase } = require('../../lib/supabase');
const { run: analyzeWorkout } = require('../../scripts/analyze-workout');

const mockInsertChain = { select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'uuid-new' }, error: null }) };
const mockDb = {
  from: jest.fn(),
  select: jest.fn(),
  eq: jest.fn(),
  neq: jest.fn(),
  in: jest.fn(),
  order: jest.fn(),
  lt: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  storage: { from: jest.fn() },
};

['from','select','eq','neq','in','order','lt','update'].forEach(m => mockDb[m].mockReturnValue(mockDb));
mockDb.insert.mockReturnValue(mockInsertChain);
mockDb.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  garmin.createGarminClient.mockResolvedValue({});
  garmin.getNewActivities.mockResolvedValue([]);
  garmin.deduplicateBikes.mockImplementation(a => ({ keep: a, duplicates: [] }));
  garmin.downloadFitFile = jest.fn().mockResolvedValue(Buffer.from('fit'));
});

test('reads known activity IDs from workouts table before fetching', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('workouts');
});

test('calls analyzeWorkout inline for each new activity', async () => {
  garmin.getNewActivities.mockResolvedValue([
    { activityId: 123, activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-03-18 08:00:00' },
  ]);
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(analyzeWorkout).toHaveBeenCalledWith('uuid-new');
});
