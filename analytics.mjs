const isValid = (value) => Number.isFinite(value) && value >= 0;
const activityKind = (identifier = '') => {
  if (/Running|Walking/i.test(identifier)) return '유산소';
  if (/Cycling/i.test(identifier)) return '사이클링';
  if (/Swim/i.test(identifier)) return '수영';
  if (/Strength|CrossTraining|FunctionalStrength/i.test(identifier)) return '근력';
  return '기타';
};

const localDateKey=(value)=>{const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};

export function summarizeRange(data,startDate,endDate) {
  const workouts=(data.workouts||[]).filter((workout)=>{const day=localDateKey(workout.startDate);return day>=startDate&&day<endDate;});
  const daily=(data.dailyActivity||[]).filter((row)=>row.date>=startDate&&row.date<endDate);
  const sum=(items,key)=>items.reduce((total,item)=>total+(isValid(item[key])?item[key]:0),0);
  const steps=daily.filter((row)=>isValid(row.stepCount));
  const energy=daily.filter((row)=>isValid(row.activeEnergyKilocalories));
  const grouped=new Map();
  workouts.forEach((workout)=>{
    const name=workout.activityTypeName||'운동';
    const value=grouped.get(name)||{name,count:0,durationSeconds:0,distanceMeters:0};
    value.count++;value.durationSeconds+=isValid(workout.durationSeconds)?workout.durationSeconds:0;
    value.distanceMeters+=isValid(workout.distanceMeters)?workout.distanceMeters:0;
    grouped.set(name,value);
  });
  return {
    workoutCount:workouts.length,
    durationSeconds:sum(workouts,'durationSeconds'),
    distanceMeters:sum(workouts,'distanceMeters'),
    activeEnergyKilocalories:sum(energy,'activeEnergyKilocalories'),
    stepCount:steps.length?sum(steps,'stepCount'):null,
    stepCoverageDays:steps.length,
    workouts,
    daily,
    activityDurations:[...grouped.values()].sort((a,b)=>b.durationSeconds-a.durationSeconds)
  };
}

export function calculatePersonalRecords(workouts) {
  const groups=new Map();
  (workouts||[]).forEach((workout)=>{
    const key=workout.activityTypeIdentifier||workout.activityTypeName||'other';
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(workout);
  });
  const records=[];
  groups.forEach((items,activityTypeIdentifier)=>{
    const name=items[0]?.activityTypeName||activityTypeIdentifier;
    const metrics=[
      ['longestDuration','최장 운동 시간',(workout)=>isValid(workout.durationSeconds)&&workout.durationSeconds>0?workout.durationSeconds:null,'max'],
      ['longestDistance','최장 거리',(workout)=>isValid(workout.distanceMeters)&&workout.distanceMeters>0?workout.distanceMeters:null,'max']
    ];
    if(/Running|Walking/i.test(activityTypeIdentifier))metrics.push(['fastestAveragePace','빠른 평균 페이스',(workout)=>workout.distanceMeters>=1000&&workout.durationSeconds>0?workout.durationSeconds/(workout.distanceMeters/1000):null,'min']);
    if(/Cycling/i.test(activityTypeIdentifier))metrics.push(['fastestAverageSpeed','빠른 평균 속도',(workout)=>workout.distanceMeters>0&&workout.durationSeconds>0?workout.distanceMeters/workout.durationSeconds*3.6:null,'max']);
    metrics.forEach(([metric,label,selector,mode])=>{
      const candidates=items.map((workout)=>({workout,value:selector(workout)})).filter((row)=>isValid(row.value)&&row.value>0);
      if(!candidates.length)return;
      const value=mode==='min'?Math.min(...candidates.map((row)=>row.value)):Math.max(...candidates.map((row)=>row.value));
      records.push({activityTypeIdentifier,activityTypeName:name,metric,label,value,count:candidates.filter((row)=>row.value===value).length});
    });
  });
  return records.sort((a,b)=>a.activityTypeName.localeCompare(b.activityTypeName,'ko'));
}

export function calculateHeartRateLoad(workouts,maximumHeartRateBPM) {
  const zones=Array(6).fill(0);
  if(!isValid(maximumHeartRateBPM)||maximumHeartRateBPM<=0)return {coverageSeconds:0,score:0,zones};
  const samples=(workouts||[]).flatMap((workout)=>workout.heartRate||[]).filter((sample)=>isValid(sample.beatsPerMinute)&&sample.beatsPerMinute>0&&Number.isFinite(Date.parse(sample.timestamp))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  let coverageSeconds=0;
  for(let i=0;i<samples.length-1;i++){
    const seconds=(Date.parse(samples[i+1].timestamp)-Date.parse(samples[i].timestamp))/1000;
    const ratio=samples[i].beatsPerMinute/maximumHeartRateBPM;
    if(seconds<=0||seconds>60||ratio<.5||ratio>1)continue;
    const zone=ratio>=.9?5:ratio>=.8?4:ratio>=.7?3:ratio>=.6?2:1;
    zones[zone]+=seconds;coverageSeconds+=seconds;
  }
  const score=zones.reduce((total,seconds,zone)=>total+seconds/60*zone,0);
  return {coverageSeconds,score,zones};
}

export function buildLocalCoachReport(current,previous,stepGoal=null) {
  const evidence=[];
  const positives=[];
  const improvements=[];
  if(current.stepCount!==null)evidence.push(`걸음 ${Math.round(current.stepCount).toLocaleString('ko-KR')}보 · 기록 ${current.stepCoverageDays}일`);
  if(current.workoutCount>0)evidence.push(`운동 ${current.workoutCount}회 · ${Math.round(current.durationSeconds/60)}분`);
  if(current.distanceMeters>0)evidence.push(`운동 거리 ${current.distanceMeters>=1000?(current.distanceMeters/1000).toFixed(1)+' km':Math.round(current.distanceMeters)+' m'}`);
  if(current.workoutCount>previous.workoutCount)positives.push(`이전 기간보다 운동이 ${current.workoutCount-previous.workoutCount}회 많아요.`);
  else if(current.workoutCount>0)positives.push(`선택한 기간에 운동 ${current.workoutCount}회를 기록했어요.`);
  if(stepGoal>0&&current.stepCount!==null){
    const target=stepGoal*current.stepCoverageDays;
    if(target>0&&current.stepCount>=target)positives.push(`기록이 있는 ${current.stepCoverageDays}일의 걸음 합계가 설정한 목표 기준을 넘었어요.`);
    else if(target>0)improvements.push(`관측된 ${current.stepCoverageDays}일 기준으로 걸음 목표까지 ${Math.round(target-current.stepCount).toLocaleString('ko-KR')}보 남았어요.`);
  }
  if(current.workoutCount<previous.workoutCount&&previous.workoutCount>0)improvements.push(`이전 기간보다 운동 기록이 ${previous.workoutCount-current.workoutCount}회 적어요. 운동을 쉬었거나 파일에 포함되지 않았을 수 있어요.`);
  if(!current.workoutCount&&!current.stepCoverageDays){
    return {mode:'local-rules',summary:'선택 기간의 기록이 아직 없어요.',positives:[],improvements:[],nextActivity:'건강 데이터 파일을 가져온 뒤 다시 분석해 주세요.',evidence:[]};
  }
  const summary=current.workoutCount?`이번 기간에는 운동 ${current.workoutCount}회, 총 ${Math.round(current.durationSeconds/60)}분을 기록했어요.`:`걸음 ${Math.round(current.stepCount||0).toLocaleString('ko-KR')}보가 ${current.stepCoverageDays}일 기록됐어요.`;
  const nextActivity=current.workoutCount?`다음 활동도 기록을 확인하며 평소 계획과 현재 컨디션에 맞춰 선택해 보세요.`:'기록이 비어 있는 날짜가 있어요. 기록이 들어오면 기간별 변화를 더 정확히 비교할 수 있어요.';
  return {mode:'local-rules',summary,positives,improvements,nextActivity,evidence};
}
