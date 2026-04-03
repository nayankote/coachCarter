jest.mock('../../lib/garmin');
jest.mock('../../lib/supabase');

const garmin = require('../../lib/garmin');
const { getSupabase } = require('../../lib/supabase');

const mockInsertChain = { select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue({ data: { id: 'uuid-new' }, error: null }) };
const mockDb = {
  from: jest.fn(),
  select: jest.fn(),
  eq: jest.fn(),
  neq: jest.fn(),
  in: jest.fn(),
  order: jest.fn(),
  lt: jest.fn(),
  limit: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
  upsert: jest.fn(),
  storage: { from: jest.fn() },
};

['from','select','eq','neq','in','order','lt','limit','update','upsert'].forEach(m => mockDb[m].mockReturnValue(mockDb));
mockDb.insert.mockReturnValue(mockInsertChain);
// Return today's date for daily_metrics so syncDailyMetrics sees "already up to date"
mockDb.limit.mockResolvedValue({ data: [{ date: new Date().toISOString().split('T')[0] }] });
mockDb.upsert.mockResolvedValue({ error: null });
mockDb.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  garmin.createGarminClient.mockResolvedValue({});
  garmin.getNewActivities.mockResolvedValue([]);
  garmin.deduplicateBikes.mockImplementation(a => ({ keep: a, duplicates: [] }));
  garmin.downloadFitFile = jest.fn().mockResolvedValue(Buffer.from('fit'));
  garmin.getSleepAndWellness = jest.fn().mockResolvedValue({ date: '2026-03-18', sleep_score: 72 });
});

test('reads known activity IDs from workouts table before fetching', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('workouts');
});

test('stores new activities with status synced (no inline analysis)', async () => {
  garmin.getNewActivities.mockResolvedValue([
    { activityId: 123, activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-03-18 08:00:00' },
  ]);
  const { run } = require('../../scripts/sync-garmin');
  await run();
  // Verify insert was called with status: 'synced'
  expect(mockDb.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'synced' }));
});
