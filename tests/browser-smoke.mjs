import { attachRoutesToWorkouts, parseGPX, parseHealthXML, parseHealthXMLFile } from '../parsers.mjs?v=5';
import { analyzeRoute } from '../route-map.mjs';
const result = document.querySelector('#result');
const healthXML = `<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="7000" startDate="2026-10-31 08:00:00 +0900"/><Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" value="6500" startDate="2026-10-31 08:00:00 +0900"/><Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="Watch" unit="km" value="5.2" startDate="2026-10-31 08:00:00 +0900"/><Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="145" startDate="2026-10-31 08:10:00 +0900"/><Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch" startDate="2026-10-31 08:00:00 +0900" endDate="2026-10-31 08:45:00 +0900" duration="45" durationUnit="min"><WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="6.15" unit="km"/><WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="291.7" unit="kcal"/><WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="128.7" minimum="94" maximum="145" unit="count/min"/></Workout></HealthData>`;
const gpx = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="37.5" lon="127.0"><ele>15.5</ele><time>2026-10-30T23:00:00Z</time></trkpt><trkpt lat="37.501" lon="127.002"><ele>18</ele><time>2026-10-30T23:20:00Z</time></trkpt></trkseg></trk></gpx>`;
try {
  const health = parseHealthXML(healthXML);
  const streamed=await parseHealthXMLFile(new Blob([healthXML]));
  if(JSON.stringify(streamed.workouts)!==JSON.stringify(health.workouts)||JSON.stringify(streamed.dailyActivity)!==JSON.stringify(health.dailyActivity))throw new Error('Streaming XML differs from DOM parser');
  const route = parseGPX(gpx, 'route_2026-10-31.gpx');
  const matched = attachRoutesToWorkouts(health,[route]);
  if (health.dailyActivity[0].stepCount !== 7000) throw new Error('source total selection failed');
  if (health.workouts[0].distanceMeters !== 6150) throw new Error('workout distance statistics parsing failed');
  if (health.workouts[0].activeEnergyKilocalories !== 291.7) throw new Error('workout energy statistics parsing failed');
  if (health.workouts[0].heartRateSummary.maximum !== 145) throw new Error('heart rate statistics parsing failed');
  if (health.workouts[0].heartRate.length !== 1) throw new Error('heart rate association failed');
  if (matched.workouts[0].route.length !== 2) throw new Error('GPX route association failed');
  if (matched.workouts[0].route[1].altitudeMeters !== 18) throw new Error('GPX elevation parsing failed');
  const points = Array.from({length:7},(_,index)=>({latitude:37.5,longitude:127+index*0.0045,timestamp:new Date(Date.UTC(2026,9,31,8,index*5)).toISOString(),altitudeMeters:[10,10,16,16,10,10,16][index]}));
  const analysis = analyzeRoute(points);
  if (analysis.splits.length !== 3 || Math.abs(analysis.elevationGainMeters - 9) > 0.01 || Math.abs(analysis.elevationLossMeters - 6) > 0.01) throw new Error(`Route analysis failed: ${JSON.stringify({splits:analysis.splits.length,gain:analysis.elevationGainMeters,loss:analysis.elevationLossMeters})}`);
  const gapTimes=[0,300_000,600_000,4_200_000,4_500_000],gapPoints=[0,0.0045,0.009,0.0135,0.018].map((longitude,index)=>({latitude:0,longitude,timestamp:new Date(Date.UTC(2026,9,31,8)+gapTimes[index]).toISOString()}));
  const gapAnalysis=analyzeRoute(gapPoints);
  if(gapAnalysis.timeGapCount!==1||gapAnalysis.splits[1].elapsedSeconds!==null)throw new Error('Long GPS time gap was included in split pace');
  result.textContent = 'PASS\nHealth XML: daily totals, workout statistics, units, heart rate\nGPX: coordinates, elevation and workout matching\nRoute: kilometer and partial splits, elevation gain/loss, long-gap pace filtering';
} catch (error) {
  result.textContent = `FAIL\n${error.stack || error}`;
  throw error;
}
