// tests/lib/fit-parser.test.js
const mockRecords = Array.from({ length: 120 }, (_, i) => ({
  power: 185 + Math.floor(i / 10) * 3,
  heart_rate: 140 + Math.floor(i / 30),
  speed: 8.5,
  timestamp: new Date(Date.now() + i * 30000),
}));

const mockFitData = {
  // fit-file-parser places sessions at top-level data.sessions[], not under data.activity
  sessions: [{
    total_elapsed_time: 3600,
    total_calories: 450,
    start_time: new Date('2026-03-18T06:00:00Z'),
    timestamp: new Date('2026-03-18T07:00:00Z'),
    avg_heart_rate: 145,
    max_heart_rate: 165,
    avg_power: 185,
    total_distance: 30,   // km (parser uses lengthUnit: 'km')
    enhanced_avg_speed: 2.0,  // km/h — used for swim avg pace
  }],
  // records are at top-level data.records[], not nested inside laps
  records: mockRecords,
  lengths: [],
  activity: {},
};

jest.mock('fit-file-parser', () => ({
  default: jest.fn().mockImplementation(() => ({
    parse: jest.fn((buf, cb) => cb(null, mockFitData)),
  })),
}));

const { parseFit, extractMetrics } = require('../../lib/fit-parser');

test('parseFit resolves with structured fit data', async () => {
  const result = await parseFit(Buffer.from('fake'));
  expect(result).toBe(mockFitData);
});

const athlete = { ftp: 190, run_threshold_sec_per_km: 290 };

test('extractMetrics returns base fields for strength', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'strength', athlete);
  expect(metrics.duration_min).toBeCloseTo(60, 0);
  expect(metrics.calories).toBe(450);
  expect(metrics.avg_power).toBeUndefined();
});

test('extractMetrics includes power fields for bike', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'bike', athlete);
  expect(metrics.avg_power).toBe(185);
  expect(metrics.normalized_power).toBeDefined();
  expect(metrics.tss).toBeDefined();
  expect(metrics.intervals_detected).toBeDefined();
  expect(metrics.power_distribution).toBeDefined();
});

test('extractMetrics includes pace and distance for run', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'run', athlete);
  expect(metrics.avg_pace_sec).toBeDefined();
  expect(metrics.distance_km).toBeCloseTo(30, 0);
});

test('extractMetrics includes distance and pace for swim', async () => {
  const metrics = await extractMetrics(Buffer.from('fake'), 'swim', athlete);
  expect(metrics.distance_km).toBeDefined();
  expect(metrics.avg_pace_sec).toBeDefined();
});
