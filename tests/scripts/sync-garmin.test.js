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
  single: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  lt: jest.fn(),
  storage: { from: jest.fn() },
};

['from','select','eq','lt','update'].forEach(m => mockDb[m].mockReturnValue(mockDb));
mockDb.single.mockResolvedValue({ data: { last_synced_at: new Date().toISOString() }, error: null });
mockDb.insert.mockReturnValue(mockInsertChain);
mockDb.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });

beforeEach(() => {
  getSupabase.mockReturnValue(mockDb);
  garmin.createGarminClient.mockResolvedValue({});
  garmin.getActivitiesSince.mockResolvedValue([]);
  garmin.deduplicateBikes.mockImplementation(a => a);
  garmin.downloadFitFile = jest.fn().mockResolvedValue(Buffer.from('fit'));
});

test('reads last_synced_at from sync_state before fetching', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.from).toHaveBeenCalledWith('sync_state');
});

test('updates last_synced_at after sync completes', async () => {
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(mockDb.update).toHaveBeenCalled();
});

test('calls analyzeWorkout inline for each new activity', async () => {
  garmin.getActivitiesSince.mockResolvedValue([
    { activityId: 123, activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-03-18 08:00:00' },
  ]);
  const { run } = require('../../scripts/sync-garmin');
  await run();
  expect(analyzeWorkout).toHaveBeenCalledWith('uuid-new');
});
