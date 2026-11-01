import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRange, calculatePersonalRecords, buildLocalCoachReport } from '../analytics.mjs';

const dataset = {
  dailyActivity: [
    {date:'2026-10-27',stepCount:8000,activeEnergyKilocalories:300},
    {date:'2026-10-28',stepCount:9000,activeEnergyKilocalories:330},
    {date:'2026-10-20',stepCount:6000,activeEnergyKilocalories:250}
  ],
  workouts: [
    {id:'a',activityTypeIdentifier:'HKWorkoutActivityTypeRunning',activityTypeName:'달리기',startDate:'2026-10-27T06:00:00Z',endDate:'2026-10-27T06:40:00Z',durationSeconds:2400,distanceMeters:8000,heartRate:[]},
    {id:'b',activityTypeIdentifier:'HKWorkoutActivityTypeRunning',activityTypeName:'달리기',startDate:'2026-10-28T06:00:00Z',endDate:'2026-10-28T06:50:00Z',durationSeconds:3000,distanceMeters:10000,heartRate:[]},
    {id:'c',activityTypeIdentifier:'HKWorkoutActivityTypeCycling',activityTypeName:'사이클링',startDate:'2026-10-20T06:00:00Z',endDate:'2026-10-20T07:00:00Z',durationSeconds:3600,distanceMeters:25000,heartRate:[]}
  ]
};

test('summarizes only the selected date range and counts observed step days', () => {
  const summary=summarizeRange(dataset,'2026-10-26','2026-11-02');
  assert.equal(summary.workoutCount,2);
  assert.equal(summary.durationSeconds,5400);
  assert.equal(summary.distanceMeters,18000);
  assert.equal(summary.stepCount,17000);
  assert.equal(summary.stepCoverageDays,2);
});

test('calculates per-sport personal records without mixing sport metrics', () => {
  const records=calculatePersonalRecords(dataset.workouts);
  assert.equal(records.find((record)=>record.activityTypeIdentifier==='HKWorkoutActivityTypeRunning'&&record.metric==='longestDistance').value,10000);
  assert.equal(records.find((record)=>record.activityTypeIdentifier==='HKWorkoutActivityTypeRunning'&&record.metric==='fastestAveragePace').value,300);
  assert.equal(records.find((record)=>record.activityTypeIdentifier==='HKWorkoutActivityTypeCycling'&&record.metric==='fastestAverageSpeed').value,25);
});

test('creates transparent local coaching grounded in changes and observed data', () => {
  const current=summarizeRange(dataset,'2026-10-26','2026-11-02');
  const previous=summarizeRange(dataset,'2026-10-19','2026-10-26');
  const report=buildLocalCoachReport(current,previous,8000);
  assert.equal(report.mode,'local-rules');
  assert.match(report.summary,/운동 2회/);
  assert.ok(report.evidence.some((item)=>item.includes('걸음')));
  assert.ok(report.nextActivity.length>0);
});

test('calculates heart-rate zone load only across short, valid sample intervals', async () => {
  const { calculateHeartRateLoad } = await import('../analytics.mjs');
  const result=calculateHeartRateLoad([{heartRate:[
    {timestamp:'2026-10-27T06:00:00Z',beatsPerMinute:100},
    {timestamp:'2026-10-27T06:00:30Z',beatsPerMinute:140},
    {timestamp:'2026-10-27T06:05:00Z',beatsPerMinute:175}
  ]}],175);
  assert.equal(result.coverageSeconds,30);
  assert.equal(result.zones[1],30);
  assert.equal(result.zones[5],0);
});

test('assigns workouts across UTC midnight to the device-local calendar day', () => {
  const nearMidnight={dailyActivity:[],workouts:[{id:'late-run',activityTypeName:'달리기',startDate:'2026-10-31T22:30:00.000Z',durationSeconds:1800}]};
  assert.equal(summarizeRange(nearMidnight,'2026-11-01','2026-11-02').workoutCount,1);
});
