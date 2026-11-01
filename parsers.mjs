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
  collectHealthNodes(root,daily,workouts,heartRates);
  return finishHealthData(daily,workouts,heartRates);
}
function collectHealthNodes(root,daily,workouts,heartRates,filterRates=false){
  for (const record of root.getElementsByTagName('Record')) {
    const field = metricTypes.get(record.getAttribute('type'));
    const date = parseAppleDate(record.getAttribute('startDate'));
    const value = convert(number(record.getAttribute('value')), record.getAttribute('unit'), field);
    if (record.getAttribute('type') === 'HKQuantityTypeIdentifierHeartRate') {
      if (Number.isFinite(date.getTime()) && value === null) {
        const bpm = number(record.getAttribute('value'));
        if (bpm !== null && ['count/min','bpm','beats/min'].includes((record.getAttribute('unit') || '').toLowerCase())) {const timestamp=date.toISOString();if(!filterRates||workouts.some(w=>timestamp>=w.startDate&&timestamp<=w.endDate))heartRates.push({ timestamp, beatsPerMinute: bpm, sourceName: record.getAttribute('sourceName') || '' });}
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
}
function finishHealthData(daily,workouts,heartRates){
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

export async function parseHealthXMLFile(file,onProgress=()=>{}){
  const header=await file.slice(0,65536).text(),tail=await file.slice(Math.max(0,file.size-4096)).text();
  if(!/<HealthData(?:\s|>)/.test(header)||!tail.includes('</HealthData>'))throw new Error('완전한 Apple 건강 XML 파일을 선택해 주세요.');
  const daily=new Map(),workouts=[],heartRates=[];
  for(const kind of ['Workout','Record']){
    const decoder=new TextDecoder(),opening=new RegExp(`<${kind}\\b`);let buffer='';
    for(let offset=0;offset<file.size;offset+=1048576){
      buffer+=decoder.decode(await file.slice(offset,offset+1048576).arrayBuffer(),{stream:offset+1048576<file.size});
      const fragments=[];let cursor=0;
      while(true){const match=opening.exec(buffer.slice(cursor));if(!match){buffer=buffer.slice(Math.max(cursor,buffer.length-32));break;}const start=cursor+match.index,tagEnd=buffer.indexOf('>',start);if(tagEnd<0){buffer=buffer.slice(start);break;}let end=tagEnd+1;
        if(kind==='Workout'&&buffer[tagEnd-1]!=='/'){const close=buffer.indexOf('</Workout>',end);if(close<0){buffer=buffer.slice(start);break;}end=close+10;}
        let fragment=buffer.slice(start,end);if(kind==='Record'){if(!/type=["']HKQuantityTypeIdentifier(?:StepCount|DistanceWalkingRunning|FlightsClimbed|ActiveEnergyBurned|HeartRate)["']/.test(fragment)){cursor=end;continue;}if(!fragment.endsWith('/>'))fragment=fragment.slice(0,-1)+'/>';}
        fragments.push(fragment);cursor=end;
      }
      if(buffer.length>16*1024*1024)throw new Error('XML 항목이 너무 크거나 닫히지 않았습니다.');
      if(fragments.length){const doc=new DOMParser().parseFromString('<HealthData>'+fragments.join('')+'</HealthData>','application/xml');if(doc.querySelector('parsererror'))throw new Error('건강 XML 항목이 손상되었습니다.');collectHealthNodes(doc.documentElement,daily,workouts,heartRates,true);}
      onProgress({phase:kind==='Workout'?'운동 찾기':'활동·심박 읽기',percent:Math.min(100,Math.round((offset+1048576)/file.size*100))});
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(opening.test(buffer))throw new Error('건강 XML의 마지막 항목이 완전하지 않습니다.');
  }
  return finishHealthData(daily,workouts,heartRates);
}
