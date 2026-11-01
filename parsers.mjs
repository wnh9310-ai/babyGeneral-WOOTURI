import { normalizeHealthExport } from './data.mjs?v=2';

const metricTypes = new Map([
  ['HKQuantityTypeIdentifierStepCount', 'stepCount'],
  ['HKQuantityTypeIdentifierDistanceWalkingRunning', 'walkingRunningDistanceMeters'],
  ['HKQuantityTypeIdentifierFlightsClimbed', 'flightsClimbed'],
  ['HKQuantityTypeIdentifierActiveEnergyBurned', 'activeEnergyKilocalories']
]);
const parseAppleDate = (value) => {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d{4})$/.exec(value || '');
  return match ? new Date(`${match[1]}T${match[2]}${match[3].slice(0, 3)}:${match[3].slice(3)}`) : new Date(NaN);
};
const number = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const convert = (value, unit, field) => {
  if (value === null) return null;
  const normalized = (unit || '').toLowerCase();
  if (field === 'stepCount' || field === 'flightsClimbed') return ['count', 'counts', '#', 'floor', 'floors'].includes(normalized) ? value : null;
  if (field === 'walkingRunningDistanceMeters') return ({m:value, meter:value, meters:value, km:value*1000, kilometer:value*1000, kilometers:value*1000, mi:value*1609.344, mile:value*1609.344, miles:value*1609.344, cm:value/100})[normalized] ?? null;
  if (field === 'activeEnergyKilocalories') return ({kcal:value, cal:value, kilocalorie:value, kilocalories:value, kj:value/4.184})[normalized] ?? null;
  return null;
};
const workoutName = (type) => ({
  HKWorkoutActivityTypeRunning:'달리기', HKWorkoutActivityTypeWalking:'걷기', HKWorkoutActivityTypeCycling:'사이클링',
  HKWorkoutActivityTypeHiking:'하이킹', HKWorkoutActivityTypeSwimming:'수영', HKWorkoutActivityTypeTraditionalStrengthTraining:'근력 운동',
  HKWorkoutActivityTypeFunctionalStrengthTraining:'기능성 근력 운동', HKWorkoutActivityTypeYoga:'요가'
})[type] || type?.replace('HKWorkoutActivityType','').replace(/([a-z])([A-Z])/g, '$1 $2') || '운동';
const stableID = (type, start, end, source) => `w-${encodeURIComponent([type, start.toISOString(), end.toISOString(), source || ''].join('|')).replaceAll('%','_')}`;

export function parseHealthXML(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('XML 파일이 손상되었거나 완전히 저장되지 않았습니다.');
  const root = xml.documentElement;
  if (root?.tagName !== 'HealthData') throw new Error('Apple 건강 앱의 export.xml 파일을 선택해 주세요.');
  const daily = new Map();
  const workouts = [];
  const heartRates = [];
  for (const record of root.getElementsByTagName('Record')) {
    const field = metricTypes.get(record.getAttribute('type'));
    const date = parseAppleDate(record.getAttribute('startDate'));
    const value = convert(number(record.getAttribute('value')), record.getAttribute('unit'), field);
    if (record.getAttribute('type') === 'HKQuantityTypeIdentifierHeartRate') {
      if (Number.isFinite(date.getTime()) && value === null) {
        const bpm = number(record.getAttribute('value'));
        if (bpm !== null && ['count/min','bpm','beats/min'].includes((record.getAttribute('unit') || '').toLowerCase())) heartRates.push({ timestamp: date.toISOString(), beatsPerMinute: bpm, sourceName: record.getAttribute('sourceName') || '' });
      }
      continue;
    }
    if (!field || value === null || !Number.isFinite(date.getTime())) continue;
    const day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const source = record.getAttribute('sourceName') || 'unknown';
    const sources = daily.get(day) || {};
    const values = sources[field] || (sources[field] = {});
    values[source] = (values[source] || 0) + value;
    daily.set(day, sources);
  }
  for (const node of root.getElementsByTagName('Workout')) {
    const type = node.getAttribute('workoutActivityType') || '';
    const start = parseAppleDate(node.getAttribute('startDate'));
    const end = parseAppleDate(node.getAttribute('endDate'));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;
    const sourceName = node.getAttribute('sourceName') || '';
    const durationValue = number(node.getAttribute('duration'));
    const durationUnit = (node.getAttribute('durationUnit') || '').toLowerCase();
    const durationSeconds = durationValue === null ? (end-start)/1000 : durationValue * (durationUnit.startsWith('min') ? 60 : durationUnit.startsWith('hour') ? 3600 : 1);
    const distanceRaw = number(node.getAttribute('totalDistance'));
    const energyRaw = number(node.getAttribute('totalEnergyBurned'));
    const statistics = new Map([...node.getElementsByTagName('WorkoutStatistics')].map((stat) => [stat.getAttribute('type'), stat]));
    const distanceStat = statistics.get('HKQuantityTypeIdentifierDistanceWalkingRunning');
    const energyStat = statistics.get('HKQuantityTypeIdentifierActiveEnergyBurned');
    const heartRateStat = statistics.get('HKQuantityTypeIdentifierHeartRate');
    workouts.push({ id: stableID(type,start,end,sourceName), activityTypeIdentifier:type, activityTypeName:workoutName(type), startDate:start.toISOString(), endDate:end.toISOString(), durationSeconds,
      distanceMeters:convert(distanceRaw,node.getAttribute('totalDistanceUnit'),'walkingRunningDistanceMeters') ?? convert(number(distanceStat?.getAttribute('sum')),distanceStat?.getAttribute('unit'),'walkingRunningDistanceMeters'),
      activeEnergyKilocalories:convert(energyRaw,node.getAttribute('totalEnergyBurnedUnit'),'activeEnergyKilocalories') ?? convert(number(energyStat?.getAttribute('sum')),energyStat?.getAttribute('unit'),'activeEnergyKilocalories'),
      heartRateSummary:heartRateStat ? { average:number(heartRateStat.getAttribute('average')), minimum:number(heartRateStat.getAttribute('minimum')), maximum:number(heartRateStat.getAttribute('maximum')) } : null,
      sourceName, heartRate:[], route:[] });
  }
  for (const rate of heartRates) {
    const candidates = workouts.filter((workout) => rate.timestamp >= workout.startDate && rate.timestamp <= workout.endDate);
    const target=candidates.find(workout=>workout.sourceName===rate.sourceName)||candidates[0];
    if (target) target.heartRate.push({ timestamp:rate.timestamp, beatsPerMinute:rate.beatsPerMinute });
  }
  const dailyActivity = [...daily.entries()].map(([date, sourceValues]) => {
    const row = { date };
    for (const field of metricTypes.values()) {
      const sources = sourceValues[field];
      row[field] = sources ? Math.max(...Object.values(sources)) : null;
    }
    return row;
  });
  return normalizeHealthExport({ schemaVersion:1, source:'apple-health-xml', generatedAt:new Date().toISOString(), dailyActivity, workouts });
}

export function parseGPX(text, name = '운동 경로') {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('GPX 경로 파일이 손상되었습니다.');
  const points = [...xml.getElementsByTagNameNS('*','trkpt'), ...xml.getElementsByTagNameNS('*','rtept')].map((node) => {
    const latitude = Number(node.getAttribute('lat'));
    const longitude = Number(node.getAttribute('lon'));
    const time = node.getElementsByTagNameNS('*','time')[0]?.textContent || '';
    const elevation = number(node.getElementsByTagNameNS('*','ele')[0]?.textContent || '');
    return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { latitude, longitude, timestamp: Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null, ...(elevation !== null ? { altitudeMeters:elevation } : {}) } : null;
  }).filter(Boolean);
  if (points.length < 2) throw new Error('GPX 파일에서 경로 좌표를 두 개 이상 찾지 못했습니다.');
  const start = points.find((point) => point.timestamp)?.timestamp || null;
  return { name, points, startDate:start };
}

export function attachRoutesToWorkouts(data, routes) {
  const workouts = data.workouts.map((workout) => ({ ...workout }));
  for (const route of routes) {
    let target = null;
    if (route.startDate) {
      target = workouts.map((workout) => ({ workout, delta: Math.abs(new Date(workout.startDate) - new Date(route.startDate)) }))
        .filter(({delta}) => delta <= 6 * 60 * 60 * 1000).sort((a,b) => a.delta-b.delta)[0]?.workout || null;
    }
    if (!target) {
      const date = route.name.match(/(\d{4})[-_](\d\d)[-_](\d\d)/);
      if (date) target = workouts.find((workout) => workout.startDate.startsWith(`${date[1]}-${date[2]}-${date[3]}`)) || null;
    }
    if (target) target.route = route.points.map((point) => ({...point}));
  }
  return { ...data, workouts };
}
