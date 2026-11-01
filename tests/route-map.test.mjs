import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRoute, calculateRouteDistanceMeters, projectRoute, routeElapsedSeconds } from '../route-map.mjs';

test('calculates route distance from GPS coordinates', () => {
  const distance = calculateRouteDistanceMeters([
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 }
  ]);

  assert.ok(Math.abs(distance - 111195) < 100);
  assert.equal(calculateRouteDistanceMeters([{ latitude: 0, longitude: 0 }]), null);
});

test('returns the elapsed GPS track time when timestamps are available', () => {
  assert.equal(routeElapsedSeconds([
    { timestamp: '2026-10-31T11:12:27.000Z' },
    { timestamp: '2026-10-31T13:08:24.000Z' }
  ]), 6957);
  assert.equal(routeElapsedSeconds([{ timestamp: null }, { timestamp: null }]), null);
});

test('projects a GPS route into a padded local map viewport', () => {
  const points = [
    { latitude: 37.500000, longitude: 127.000000 },
    { latitude: 37.500319, longitude: 127.000632 },
    { latitude: 37.500638, longitude: 127.001264 }
  ];

  const projected = projectRoute(points, 600, 260, 28);

  assert.equal(projected.length, 3);
  for (const point of projected) {
    assert.ok(point.x >= 28 && point.x <= 572);
    assert.ok(point.y >= 28 && point.y <= 232);
  }
  assert.ok(projected[0].x < projected[2].x);
  assert.ok(projected[0].y > projected[2].y);
});

test('rejects routes with fewer than two distinct valid coordinates', () => {
  assert.equal(projectRoute([{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 }]), null);
  assert.equal(projectRoute([{ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 1 }]), null);
});

test('analyzes timed route into kilometer and partial splits with elevation and heart rate', () => {
  const start = Date.parse('2026-10-31T10:00:00Z');
  const points = [100, 100, 110, 110, 100, 100].map((altitudeMeters, index) => ({
    latitude: 0,
    longitude: index * 0.0044966,
    timestamp: new Date(start + index * 300_000).toISOString(),
    altitudeMeters
  }));
  const analysis = analyzeRoute(points, { heartRate: [150, 450, 800, 1000, 1300, 1450].map((seconds, index) => ({
    timestamp: new Date(start + seconds * 1000).toISOString(), beatsPerMinute: 100 + index * 10
  })) });

  assert.equal(analysis.splits.length, 3);
  assert.ok(Math.abs(analysis.splits[0].distanceMeters - 1000) < 10);
  assert.ok(Math.abs(analysis.splits[2].distanceMeters - 500) < 10);
  assert.ok(Math.abs(analysis.splits[0].elapsedSeconds - 600) < 0.01);
  assert.equal(analysis.splits[1].averageHeartRate, 125);
  assert.equal(analysis.elevationGainMeters, 10);
  assert.equal(analysis.elevationLossMeters, 10);
});

test('rejects invalid coordinates and implausible GPS jumps without changing source points', () => {
  const points = [
    { latitude: 0, longitude: 0, timestamp: '2026-10-31T10:00:00Z' },
    { latitude: 91, longitude: 0, timestamp: '2026-10-31T10:00:05Z' },
    { latitude: 0, longitude: 0.001, timestamp: '2026-10-31T10:00:10Z' },
    { latitude: 0, longitude: 2, timestamp: '2026-10-31T10:00:11Z' },
    { latitude: 0, longitude: 0.002, timestamp: '2026-10-31T10:00:20Z' }
  ];
  const original = structuredClone(points);
  const analysis = analyzeRoute(points);

  assert.equal(analysis.rejectedPointCount, 2);
  assert.ok(analysis.distanceMeters < 300);
  assert.deepEqual(points, original);
});

test('does not report split pace or heart rate across a long GPS timestamp gap', () => {
  const start = Date.parse('2026-10-31T10:00:00Z');
  const points = [0, 0.0045, 0.009, 0.0135, 0.018].map((longitude, index) => ({
    latitude: 0,
    longitude,
    timestamp: new Date(start + [0, 300_000, 600_000, 4_200_000, 4_500_000][index]).toISOString()
  }));
  const analysis = analyzeRoute(points, { heartRate: [{ timestamp:new Date(start+2_000_000).toISOString(), beatsPerMinute:130 }] });

  assert.equal(analysis.timeGapCount, 1);
  assert.ok(Math.abs(analysis.splits[0].elapsedSeconds - 600) < 1);
  assert.equal(analysis.splits[1].elapsedSeconds, null);
  assert.equal(analysis.splits[1].averagePaceSecondsPerKilometer, null);
  assert.equal(analysis.splits[1].averageHeartRate, null);
});

test('returns distance-aligned route samples with speed omitted across long time gaps', () => {
  const start = Date.parse('2026-10-31T10:00:00Z');
  const analysis = analyzeRoute([0, 0.001, 0.002].map((longitude, index) => ({
    latitude: 0,
    longitude,
    timestamp: new Date(start + [0, 120_000, 900_000][index]).toISOString(),
    altitudeMeters: 20 + index * 5
  })));

  assert.equal(analysis.track.length, 3);
  assert.equal(analysis.track[0].speedKilometersPerHour, null);
  assert.ok(Math.abs(analysis.track[1].speedKilometersPerHour - 3.34) < 0.03);
  assert.equal(analysis.track[2].speedKilometersPerHour, null);
  assert.equal(analysis.track[2].altitudeMeters, 30);
  assert.ok(analysis.track[2].cumulativeDistanceMeters > analysis.track[1].cumulativeDistanceMeters);
});
