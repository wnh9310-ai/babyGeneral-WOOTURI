const finiteOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const isoDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const stableWorkoutId = (workout) => {
  const source = [workout.activityTypeIdentifier || workout.activityTypeName || 'workout', workout.startDate, workout.endDate, workout.sourceName || ''].join('|');
  return `w-${encodeURIComponent(source).replaceAll('%', '_')}`;
};

export function normalizeHealthExport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('건강 데이터 파일 형식을 확인해 주세요.');
  if (input.schemaVersion !== 1) throw new Error('지원하지 않는 단축어 데이터 버전입니다.');
  const dailyActivity = (Array.isArray(input.dailyActivity) ? input.dailyActivity : []).flatMap((row) => {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return [];
    return [{
      date: row.date,
      stepCount: finiteOrNull(row.stepCount),
      walkingRunningDistanceMeters: finiteOrNull(row.walkingRunningDistanceMeters),
      flightsClimbed: finiteOrNull(row.flightsClimbed),
      activeEnergyKilocalories: finiteOrNull(row.activeEnergyKilocalories)
    }];
  });
  const workouts = (Array.isArray(input.workouts) ? input.workouts : []).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const startDate = isoDate(row.startDate);
    const endDate = isoDate(row.endDate);
    const durationSeconds = finiteOrNull(row.durationSeconds);
    if (!startDate || !endDate || new Date(endDate) <= new Date(startDate) || !durationSeconds) return [];
    const workout = {
      id: typeof row.id === 'string' && row.id ? row.id : null,
      activityTypeIdentifier: String(row.activityTypeIdentifier || ''),
      activityTypeName: String(row.activityTypeName || '운동'),
      startDate,
      endDate,
      durationSeconds,
      distanceMeters: finiteOrNull(row.distanceMeters),
      activeEnergyKilocalories: finiteOrNull(row.activeEnergyKilocalories),
      heartRateSummary: row.heartRateSummary ? { average: finiteOrNull(row.heartRateSummary.average), minimum: finiteOrNull(row.heartRateSummary.minimum), maximum: finiteOrNull(row.heartRateSummary.maximum) } : null,
      sourceName: String(row.sourceName || ''),
      heartRate: (Array.isArray(row.heartRate) ? row.heartRate : []).flatMap((sample) => {
        const timestamp = isoDate(sample?.timestamp);
        const beatsPerMinute = finiteOrNull(sample?.beatsPerMinute);
        return timestamp && beatsPerMinute !== null ? [{ timestamp, beatsPerMinute }] : [];
      }),
      route: Array.isArray(row.route) ? row.route.flatMap((point) => {
        const lat = Number(point?.latitude);
        const lon = Number(point?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
        const timestamp = isoDate(point?.timestamp);
        const altitudeMeters = Number(point?.altitudeMeters);
        return [{ latitude: lat, longitude: lon, ...(timestamp ? { timestamp } : {}), ...(Number.isFinite(altitudeMeters) ? { altitudeMeters } : {}) }];
      }) : []
    };
    workout.id ||= stableWorkoutId(workout);
    return [workout];
  });
  if (dailyActivity.length === 0 && workouts.length === 0) throw new Error('가져올 걸음·활동·운동 데이터가 없습니다.');
  return { schemaVersion: 1, source: String(input.source || 'local-file'), generatedAt: isoDate(input.generatedAt) || new Date().toISOString(), dailyActivity, workouts };
}

export function mergeHealthData(existing, incoming) {
  const days = new Map((existing?.dailyActivity || []).map((row) => [row.date, row]));
  for (const row of incoming.dailyActivity || []) days.set(row.date, row);
  const workouts = new Map((existing?.workouts || []).map((row) => [row.id, row]));
  for (const row of incoming.workouts || []) workouts.set(row.id, row);
  return {
    schemaVersion: 1,
    source: 'local-files',
    generatedAt: new Date().toISOString(),
    dailyActivity: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    workouts: [...workouts.values()].sort((a, b) => b.startDate.localeCompare(a.startDate))
  };
}
