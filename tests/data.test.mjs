import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHealthExport, mergeHealthData } from '../data.mjs';

test('normalizes valid Shortcut health export and generates stable workout ids', () => {
  const input = {
    schemaVersion: 1,
    source: 'apple-shortcuts',
    generatedAt: '2026-11-01T07:00:00Z',
    dailyActivity: [{ date: '2026-11-01', stepCount: 7342, walkingRunningDistanceMeters: 5120 }],
    workouts: [{
      activityTypeIdentifier: 'HKWorkoutActivityTypeRunning',
      activityTypeName: '달리기',
      startDate: '2026-11-01T06:00:00+09:00',
      endDate: '2026-11-01T06:45:00+09:00',
      durationSeconds: 2700,
      distanceMeters: 7000,
      heartRateSummary: { average: 132, minimum: 88, maximum: 166 },
      sourceName: 'Apple Watch',
      heartRate: [{ timestamp: '2026-11-01T06:10:00+09:00', beatsPerMinute: 145 }]
    }]
  };
  const first = normalizeHealthExport(input);
  const second = normalizeHealthExport(input);
  assert.equal(first.dailyActivity[0].stepCount, 7342);
  assert.equal(first.workouts[0].id, second.workouts[0].id);
  assert.equal(first.workouts[0].heartRate[0].beatsPerMinute, 145);
  assert.equal(first.workouts[0].heartRateSummary.maximum, 166);
});

test('rejects unsupported or unsafe health export values', () => {
  assert.throws(() => normalizeHealthExport({ schemaVersion: 2 }), /지원하지 않는/);
  assert.throws(() => normalizeHealthExport({ schemaVersion: 1, workouts: [{ durationSeconds: -1 }] }), /운동 데이터/);
});

test('merges repeated imports by date and stable workout id', () => {
  const data = normalizeHealthExport({
    schemaVersion: 1,
    dailyActivity: [{ date: '2026-11-01', stepCount: 1000 }],
    workouts: [{ activityTypeName: '달리기', startDate: '2026-11-01T06:00:00Z', endDate: '2026-11-01T06:30:00Z', durationSeconds: 1800 }]
  });
  const merged = mergeHealthData(data, data);
  assert.equal(merged.dailyActivity.length, 1);
  assert.equal(merged.workouts.length, 1);
});

test('preserves XML heart rate zone boundaries and durations',()=>{
 const input={schemaVersion:1,workouts:[{activityTypeName:'달리기',startDate:'2026-11-01T00:00:00Z',endDate:'2026-11-01T00:10:00Z',durationSeconds:600,heartRateZones:[{minimum:null,maximum:137,durationSeconds:60},{minimum:137,maximum:149,durationSeconds:240}]}]};
 const zone=normalizeHealthExport(input).workouts[0].heartRateZones;
 assert.equal(zone.length,2);assert.equal(zone[0].minimum,null);assert.equal(zone[1].durationSeconds,240);
});
