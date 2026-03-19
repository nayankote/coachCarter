jest.mock('garmin-connect', () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(undefined),
    getActivities: jest.fn(),
    downloadOriginalActivityData: jest.fn(),
  })),
}));
jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('garmin-pass') }));

process.env.GARMIN_EMAIL = 'test@example.com';

const { createGarminClient, getActivitiesSince, resolveSource, deduplicateBikes } =
  require('../../lib/garmin');

test('createGarminClient logs in with email + Keychain password', async () => {
  const client = await createGarminClient();
  expect(client.login).toHaveBeenCalledWith('test@example.com', 'garmin-pass');
});

test('getActivitiesSince filters activities after the given date', async () => {
  const since = new Date('2026-03-18T00:00:00Z');
  const activities = [
    { activityId: 1, startTimeGMT: '2026-03-19 08:00:00' },
    { activityId: 2, startTimeGMT: '2026-03-17 08:00:00' },
  ];
  const client = { getActivities: jest.fn().mockResolvedValue(activities) };
  const result = await getActivitiesSince(client, since);
  expect(result).toHaveLength(1);
  expect(result[0].activityId).toBe(1);
});

test('resolveSource returns "zwift" for virtual_ride activities', () => {
  expect(resolveSource({ activityType: { typeKey: 'virtual_ride' } })).toBe('zwift');
});

test('resolveSource returns "watch" for regular cycling', () => {
  expect(resolveSource({ activityType: { typeKey: 'cycling' } })).toBe('watch');
});

test('deduplicateBikes prefers Zwift when both sources present on same day', () => {
  const activities = [
    { activityId: 10, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'virtual_ride' } },
    { activityId: 11, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
    { activityId: 12, sport: 'run',  date: '2026-03-18', activityType: { typeKey: 'running' } },
  ];
  const result = deduplicateBikes(activities);
  expect(result.map(a => a.activityId)).toEqual([10, 12]);
});

test('deduplicateBikes keeps all activities when source cannot be determined', () => {
  const activities = [
    { activityId: 20, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
    { activityId: 21, sport: 'bike', date: '2026-03-18', activityType: { typeKey: 'cycling' } },
  ];
  const result = deduplicateBikes(activities);
  expect(result).toHaveLength(2);
});
