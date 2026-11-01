import { mergeHealthData, normalizeHealthExport } from './data.mjs?v=2';
import { attachRoutesToWorkouts, parseGPX, parseHealthXML } from './parsers.mjs?v=3';
import { buildLocalCoachReport, calculateHeartRateLoad, calculatePersonalRecords, summarizeRange } from './analytics.mjs';
import { analyzeRoute, buildRouteMapSVG, calculateRouteDistanceMeters, projectRoute } from './route-map.mjs';
import { readHealthExportZip } from './archive.mjs?v=2';

const DB_NAME = 'wuturi-local-health-v1';
const STORE_KEY = 'health-data';
const emptyData = () => ({ schemaVersion:1, source:'local-files', generatedAt:new Date().toISOString(), dailyActivity:[], workouts:[], routeFiles:[] });
let data = emptyData();
let selectedPhoto = null;
let selectedWorkout = null;
let analysisDays = 7;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarMode = 'month';
let coachPeriod = 'daily';
let photoImage = null;
let stamp = { x:0, y:0, scale:1 };
let stampLayout = 'classic';
let routeTrack = [];
let routeCursorMarker = null;
let activeDetailWorkout = null;
let canvasContext;
let toastTimer;
const $ = (selector) => document.querySelector(selector);
const database = new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) return reject(new Error('이 브라우저는 로컬 저장을 지원하지 않습니다.'));
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('records');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('기기 저장공간을 열 수 없습니다.'));
});
const saveData = async () => {
  const db = await database;
  await new Promise((resolve,reject) => {
    const tx = db.transaction('records','readwrite');
    tx.objectStore('records').put(data, STORE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
};
const readData = async () => {
  const db = await database;
  return new Promise((resolve,reject) => {
    const request = db.transaction('records').objectStore('records').get(STORE_KEY);
    request.onsuccess = () => resolve(request.result || emptyData());
    request.onerror = () => reject(request.error);
  });
};
const clearData = async () => {
  const db = await database;
  await new Promise((resolve,reject) => {
    const tx = db.transaction('records','readwrite');
    tx.objectStore('records').delete(STORE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
};
function announce(message, persist = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), persist ? 4500 : 2600);
}
function prettyNumber(value) { return new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0}).format(value); }
function displayDistance(meters) {
  if (meters == null) return '거리 미기록';
  return meters >= 1000 ? `${(meters/1000).toFixed(meters >= 10000 ? 1 : 2)} km` : `${prettyNumber(meters)} m`;
}
function displayDuration(seconds) {
  const minutes = Math.round(seconds/60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes/60)}시간 ${String(minutes%60).padStart(2,'0')}분`;
}
function displayPaceValue(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '미기록';
  const rounded = Math.round(secondsPerKm);
  return `${Math.floor(rounded/60)}′${String(rounded%60).padStart(2,'0')}″ /km`;
}
function workoutDistance(workout,routeDistanceMeters=null) {
  if (Number.isFinite(workout.distanceMeters) && workout.distanceMeters >= 100) return { meters:workout.distanceMeters, estimated:false };
  const meters=routeDistanceMeters ?? calculateRouteDistanceMeters(workout.route);
  return meters != null && meters >= 100 ? { meters, estimated:true } : null;
}
function displayWorkoutDistance(workout,routeDistanceMeters=null) {
  const distance=workoutDistance(workout,routeDistanceMeters);
  return distance ? `${distance.estimated?'≈ ':''}${displayDistance(distance.meters)}` : displayDistance(workout.distanceMeters);
}
function displayPace(workout,routeDistanceMeters=null) {
  const distance=workoutDistance(workout,routeDistanceMeters);
  if (!distance || !workout.durationSeconds) return null;
  const seconds = workout.durationSeconds / (distance.meters/1000);
  return `${distance.estimated?'≈ ':''}${displayPaceValue(seconds)}`;
}
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }

function renderWeeklySummary() {
  const now=new Date();
  const weekday=(now.getDay()+6)%7;
  const monday=new Date(now);monday.setHours(0,0,0,0);monday.setDate(now.getDate()-weekday);
  const workouts=data.workouts.filter((workout)=>new Date(workout.startDate)>=monday);
  const minutes=Math.round(workouts.reduce((total,workout)=>total+workout.durationSeconds,0)/60);
  $('#week-summary').textContent=`${workouts.length}회 · ${minutes}분`;
}

function renderSteps() {
  const host = $('#steps-chart');
  host.replaceChildren();
  const today = new Date();
  const days = Array.from({length:7},(_,index) => {
    const date = new Date(today); date.setDate(today.getDate() - (6-index)); return date;
  });
  const records = new Map(data.dailyActivity.map((row) => [row.date,row]));
  const max = Math.max(1,...days.map((day) => records.get(localDateKey(day))?.stepCount || 0));
  const values = days.map((day) => records.get(localDateKey(day))?.stepCount).filter((value) => value != null);
  days.forEach((day) => {
    const value = records.get(localDateKey(day))?.stepCount || 0;
    const cell = document.createElement('div'); cell.className = `step-day${localDateKey(day) === localDateKey(today) ? ' today' : ''}`;
    const label = day.toLocaleDateString('ko-KR',{weekday:'short'});
    cell.innerHTML = `<span class="step-value">${value ? prettyNumber(value) : '—'}</span><span class="step-track"><span class="step-bar" data-level="${value ? Math.max(1,Math.round(value/max*10)) : 0}"></span></span><span class="step-label">${label}</span>`;
    host.append(cell);
  });
  $('#step-average').textContent = values.length ? `기록일 평균 ${prettyNumber(values.reduce((a,b)=>a+b,0)/values.length)}보` : '기록 대기 중';
}
function renderWorkouts() {
  const host = $('#workout-list'); host.replaceChildren();
  const workouts = [...data.workouts].sort((a,b) => b.startDate.localeCompare(a.startDate));
  $('#workout-count').textContent = `${workouts.length}개`;
  if (!workouts.length) {
    const empty = document.createElement('p'); empty.className = 'empty-row'; empty.textContent = '아직 가져온 운동이 없습니다. Apple 건강 XML 또는 단축어 JSON을 선택해 주세요.'; host.append(empty); return;
  }
  workouts.slice(0,5).forEach((workout) => host.append(makeWorkoutRow(workout)));
}
function renderRoutes() {
  const select = $('#route-select');
  const previous = select.value;
  select.replaceChildren(new Option('경로가 있는 운동을 선택하세요',''));
  data.workouts.filter((workout) => workout.route?.length > 1).forEach((workout) => {
    const date = new Date(workout.startDate).toLocaleDateString('ko-KR',{month:'numeric',day:'numeric'});
    select.add(new Option(`${date} ${workout.activityTypeName} · ${displayWorkoutDistance(workout)}`,workout.id));
  });
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function makeWorkoutRow(workout) {
  const row=document.createElement('button');row.type='button';row.className='workout-row workout-row-button';
  const date=new Date(workout.startDate).toLocaleString('ko-KR',{year:'numeric',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'});
  row.innerHTML=`<span class="workout-icon" aria-hidden="true">${workout.route?.length>1?'⌁':'↗'}</span><span class="workout-main"><strong></strong><span></span></span><span class="workout-measure"><strong></strong><span></span></span>`;
  row.querySelector('.workout-main strong').textContent=workout.activityTypeName||'운동';
  row.querySelector('.workout-main span').textContent=`${date} · ${displayDuration(workout.durationSeconds)}${workout.route?.length>1?' · 경로 있음':''}`;
  row.querySelector('.workout-measure strong').textContent=displayWorkoutDistance(workout);
  row.querySelector('.workout-measure span').textContent=displayPace(workout)||(workout.activeEnergyKilocalories!=null?`${prettyNumber(workout.activeEnergyKilocalories)} kcal`:'상세 기록');
  row.addEventListener('click',()=>showWorkoutDetail(workout));return row;
}
function renderFullWorkoutList() {
  const host=$('#workout-full-list');if(!host)return;host.replaceChildren();
  const query=($('#workout-search')?.value||'').trim().toLocaleLowerCase('ko');const type=$('#workout-type-filter')?.value||'';
  const workouts=[...data.workouts].filter((workout)=>(!type||workout.activityTypeIdentifier===type)&&(!query||`${workout.activityTypeName} ${workout.sourceName}`.toLocaleLowerCase('ko').includes(query))).sort((a,b)=>b.startDate.localeCompare(a.startDate));
  $('#workout-total-count').textContent=`${workouts.length}개`;
  if(!workouts.length){const empty=document.createElement('p');empty.className='empty-row';empty.textContent=data.workouts.length?'조건에 맞는 운동이 없습니다.':'건강 XML 또는 단축어 JSON 파일을 가져오면 운동이 여기에 표시됩니다.';host.append(empty);return;}
  workouts.forEach((workout)=>host.append(makeWorkoutRow(workout)));
}
function renderWorkoutTypeFilter(){
  const select=$('#workout-type-filter');if(!select)return;const previous=select.value;select.replaceChildren(new Option('모든 종목',''));
  const types=new Map(data.workouts.map((workout)=>[workout.activityTypeIdentifier,workout.activityTypeName]));
  [...types].sort((a,b)=>a[1].localeCompare(b[1],'ko')).forEach(([id,name])=>select.add(new Option(name,id)));
  if(types.has(previous))select.value=previous;
}
let naverMapsPromise;
function loadNaverMaps(){
  if(window.naver?.maps)return Promise.resolve(window.naver.maps);
  const key=localStorage.getItem('wuturi-naver-map-keyid');if(!key)return Promise.reject(new Error('네이버 지도 클라이언트 ID를 설정해 주세요.'));
  if(naverMapsPromise)return naverMapsPromise;
  naverMapsPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`;script.async=true;script.onload=()=>window.naver?.maps?resolve(window.naver.maps):reject(new Error('네이버 지도 API를 불러오지 못했습니다.'));script.onerror=()=>reject(new Error('네이버 지도 연결에 실패했습니다.'));document.head.append(script);});
  return naverMapsPromise;
}
function renderNaverRouteMap(workout,track){
  routeCursorMarker=null;
  if(!localStorage.getItem('wuturi-naver-map-keyid')||track?.length<2)return;
  loadNaverMaps().then((maps)=>{
    if($('#detail-title').dataset.workoutId!==workout.id)return;
    const host=$('#detail-route-map'),canvas=document.createElement('div');canvas.className='naver-route-canvas';host.replaceChildren(canvas);
    const path=track.map((point)=>new maps.LatLng(point.latitude,point.longitude));
    const map=new maps.Map(canvas,{center:path[0],zoom:14,zoomControl:false,scaleControl:false,logoControl:true,mapDataControl:false});
    const bounds=new maps.LatLngBounds();path.forEach((point)=>bounds.extend(point));map.fitBounds(bounds);
    new maps.Polyline({map,path,strokeColor:'#22a06b',strokeOpacity:.95,strokeWeight:5});
    new maps.Marker({map,position:path[0],title:'시작'});new maps.Marker({map,position:path.at(-1),title:'도착'});routeCursorMarker=new maps.Marker({map,position:path[0],title:'선택한 거리',icon:{content:'<span class="route-cursor-pin"></span>',anchor:new maps.Point(8,8)}});
  }).catch((error)=>announce(`${error.message} 로컬 경로로 표시합니다.`,true));
}
let leafletPromise;
function renderOpenMap(workout,track){
  if(!track)return;
  if(!leafletPromise)leafletPromise=new Promise((resolve,reject)=>{
    const css=document.createElement('link');css.rel='stylesheet';css.href='./vendor/leaflet/leaflet.css';document.head.append(css);
    const script=document.createElement('script');script.src='./vendor/leaflet/leaflet.js';script.onload=()=>resolve(window.L);script.onerror=()=>{leafletPromise=null;reject(new Error('지도를 불러오지 못했습니다. 경로 미리보기를 표시합니다.'));};document.head.append(script);
  });
  leafletPromise.then((L)=>{
    if(activeDetailWorkout?.id!==workout.id)return;
    const host=$('#detail-route-map'),canvas=document.createElement('div');canvas.className='naver-route-canvas';host.replaceChildren(canvas);
    const map=L.map(canvas,{scrollWheelZoom:false}).setView([36.3,127.8],7),path=track.map(p=>[p.latitude,p.longitude]);
    new ResizeObserver(()=>map.invalidateSize()).observe(canvas);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
    if(!path.length)return;
    const line=L.polyline(path,{color:'#21756e',weight:5}).addTo(map);map.fitBounds(line.getBounds(),{padding:[24,24],maxZoom:17});
    L.circleMarker(path[0],{radius:6,color:'#fff',fillColor:'#25a76f',fillOpacity:1}).addTo(map);
    L.circleMarker(path.at(-1),{radius:6,color:'#fff',fillColor:'#e66e5d',fillOpacity:1}).addTo(map);
    const cursor=L.circleMarker(path[0],{radius:8,color:'#202a27',fillColor:'#fff',fillOpacity:1}).addTo(map);
    routeCursorMarker=(point)=>cursor.setLatLng([point.latitude,point.longitude]);
  }).catch(error=>announce(error.message,true));
}
function showWorkoutDetail(workout){
  $('.workout-detail-inner').scrollTop=0;
  activeDetailWorkout=workout;
  $('#detail-date').textContent=new Date(workout.startDate).toLocaleString('ko-KR',{dateStyle:'long',timeStyle:'short'});$('#detail-title').textContent=workout.activityTypeName||'운동';$('#detail-title').dataset.workoutId=workout.id;
  const routeAnalysis=analyzeRoute(workout.route,{heartRate:workout.heartRate}),routeTrack=routeAnalysis.track;
  const routeSection=$('#detail-route-section'),routeMap=$('#detail-route-map'),routeSvg=buildRouteMapSVG(routeTrack);routeMap.replaceChildren();routeSection.hidden=false;if(routeSvg){routeMap.innerHTML=routeSvg;routeMap.querySelector('svg')?.insertAdjacentHTML('beforeend','<circle id="route-cursor" r="8" fill="#fff" stroke="#202a27" stroke-width="3"/>');}
  renderCombinedChart(workout,routeAnalysis);
  $('#detail-route-note').textContent='지도 지역과 IP는 OpenStreetMap 서버로 전달됩니다. 운동 기록과 경로 선은 이 브라우저에서 처리합니다.';
  window.setTimeout(()=>renderOpenMap(workout,routeTrack),0);
  const distance=workoutDistance(workout,routeAnalysis.distanceMeters),metricNote=$('#detail-metric-note');
  const timeMismatch=routeAnalysis.elapsedSeconds&&workout.durationSeconds&&Math.abs(routeAnalysis.elapsedSeconds-workout.durationSeconds)>600;
  metricNote.hidden=!distance?.estimated&&!timeMismatch;
  if(!metricNote.hidden){const distanceNote=distance?.estimated?'GPS 점으로 계산한 추정 거리입니다. 페이스는 운동 기록 시간 기준입니다. ':'';const timingNote=timeMismatch?`경로 기록의 경과시간은 ${displayDuration(routeAnalysis.elapsedSeconds)}, 운동 기록 시간은 ${displayDuration(workout.durationSeconds)}입니다. GPS 시간 공백이 포함될 수 있어 공식 운동 시간은 바꾸지 않았습니다.`:'';metricNote.textContent=`${distanceNote}${timingNote}`;}
  const highlights=[['거리',displayWorkoutDistance(workout,routeAnalysis.distanceMeters),distance?.estimated?'GPS 추정':''],['운동 시간',displayDuration(workout.durationSeconds),''],['평균 페이스',displayPace(workout,routeAnalysis.distanceMeters)||'미기록',''],['활동 에너지',workout.activeEnergyKilocalories==null?'미기록':`${prettyNumber(workout.activeEnergyKilocalories)} kcal`,'']];
  const cards=$('#detail-highlights');cards.replaceChildren();highlights.forEach(([label,value,note])=>{const card=document.createElement('div');card.className='detail-stat';const name=document.createElement('span');name.textContent=label;const figure=document.createElement('strong');figure.textContent=value;const foot=document.createElement('small');foot.textContent=note;card.append(name,figure,foot);cards.append(card);});
  const rates=(workout.heartRate||[]).map((sample)=>sample.beatsPerMinute).filter(Number.isFinite),summary=workout.heartRateSummary||{},heart=$('#detail-heart-rate');heart.replaceChildren();
  const avg=summary.average??(rates.length?rates.reduce((a,b)=>a+b,0)/rates.length:null),max=summary.maximum??(rates.length?Math.max(...rates):null),min=summary.minimum??(rates.length?Math.min(...rates):null);
  const hrLine=document.createElement('p');hrLine.className='detail-heart';hrLine.textContent=avg===null?'심박 통계가 기록되지 않았습니다.':`평균 ${Math.round(avg)} bpm　최저 ${Math.round(min)}　최고 ${Math.round(max)}${rates.length?` · ${rates.length}개 표본`:''}`;heart.append(hrLine);
  if(rates.length>2){const lo=Math.min(...rates),hi=Math.max(...rates),span=Math.max(1,hi-lo);const points=rates.map((rate,index)=>`${(index/(rates.length-1)*600).toFixed(1)},${(90-(rate-lo)/span*74).toFixed(1)}`).join(' ');heart.insertAdjacentHTML('beforeend',`<svg class="detail-heart-chart" viewBox="0 0 600 100" role="img" aria-label="운동 중 심박 변화"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`);}
  renderRouteAnalysis(workout,routeAnalysis);
  const extra=$('#detail-metrics');extra.replaceChildren();[['기록 출처',workout.sourceName||'미상'],['GPS 경로',workout.route?.length>1?`${workout.route.length.toLocaleString('ko-KR')}개 지점`:'없음']].forEach(([label,value])=>{const row=document.createElement('div');row.className='detail-row';row.innerHTML='<span></span><strong></strong>';row.children[0].textContent=label;row.children[1].textContent=value;extra.append(row);});
  addRouteReplay(workout,routeAnalysis.track);
  $('#workout-dialog').showModal();
}
function renderCombinedChart(workout,analysis){
  routeTrack=analysis.track;routeCursorMarker=null;
  const host=$('#detail-combined-chart');host.replaceChildren();if(routeTrack.length<2)return;
  const total=Math.max(1,analysis.distanceMeters),left=56,right=580,top=36,bottom=340;
  const distanceAtTime=(time)=>{for(let i=1;i<routeTrack.length;i++){const a=routeTrack[i-1],b=routeTrack[i];if(a.timestamp===null||b.timestamp===null||time<a.timestamp||time>b.timestamp||b.timeGap)continue;return a.cumulativeDistanceMeters+(b.cumulativeDistanceMeters-a.cumulativeDistanceMeters)*(time-a.timestamp)/(b.timestamp-a.timestamp);}return null;};
  const heart=(workout.heartRate||[]).flatMap(sample=>{const distance=distanceAtTime(Date.parse(sample.timestamp||'')),value=Number(sample.beatsPerMinute);return distance!==null&&Number.isFinite(value)&&value>0?[{distance,value}]:[];}).sort((a,b)=>a.distance-b.distance);
  const series=[{name:'고도 (m)',color:'#27856a',points:routeTrack.map(p=>({distance:p.cumulativeDistanceMeters,value:p.altitudeMeters,gap:p.timeGap}))},{name:'심박 (bpm) · XML',color:'#c65b4d',points:heart},{name:'속도 (km/h)',color:'#5475c6',points:routeTrack.map(p=>({distance:p.cumulativeDistanceMeters,value:p.speedKilometersPerHour,gap:p.timeGap}))}];
  series.forEach(s=>{const values=s.points.map(p=>p.value).filter(Number.isFinite);s.min=values.length?Math.min(...values):0;s.max=values.length?Math.max(...values):0;});
  const min=0,span=100;
  const legend=document.createElement('div');legend.className='route-chart-legend';series.forEach(s=>{const item=document.createElement('span');item.style.color=s.color;item.textContent=`${s.name}${s.points.some(p=>Number.isFinite(p.value))?` · ${s.min.toFixed(1)}–${s.max.toFixed(1)}`:' · 미기록'}`;legend.append(item);});host.append(legend);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 380');svg.setAttribute('role','img');svg.setAttribute('aria-label','지표별 배율을 맞춰 하나의 Y축에 겹쳐 표시한 고도, XML 심박, 속도 그래프');
  const node=(name,attrs,text)=>{const n=document.createElementNS(svg.namespaceURI,name);Object.entries(attrs).forEach(([key,value])=>n.setAttribute(key,String(value)));if(text!==undefined)n.textContent=text;svg.append(n);return n;};
  for(let i=0;i<=4;i++){const y=bottom-i/4*(bottom-top);node('line',{x1:left,x2:right,y1:y,y2:y,class:'route-chart-baseline'});node('text',{x:left-8,y:y+4,'text-anchor':'end',class:'route-chart-tick'},`${Math.round(min+span*i/4)}%`);}
  series.forEach(s=>{let d='',connected=false;s.points.forEach(p=>{if(!Number.isFinite(p.value)){connected=false;return;}const x=left+p.distance/total*(right-left),y=bottom-(s.max===s.min ? .5 : (p.value-s.min)/(s.max-s.min))*(bottom-top);d+=`${connected&&!p.gap?'L':'M'}${x.toFixed(1)},${y.toFixed(1)} `;connected=true;});node('path',{d,fill:'none',stroke:s.color,'stroke-width':3,'stroke-linejoin':'round','stroke-linecap':'round'});});
  [0,.25,.5,.75,1].forEach(f=>node('text',{x:left+f*(right-left),y:370,'text-anchor':'middle',class:'route-chart-tick'},`${(total*f/1000).toFixed(1)} km`));
  node('line',{id:'route-chart-cursor',y1:top,y2:bottom,class:'route-chart-cursor'});host.append(svg);
  const note=document.createElement('p');note.className='subnote';note.textContent=`각 지표의 최저–최고를 0–100%로 맞춘 겹침 그래프 · 실제 값은 범례와 선택 지점에 표시 · XML 심박 ${heart.length.toLocaleString()}개 표본. GPS 시각과 연결할 수 없는 표본은 그래프에서 제외합니다.`;host.append(note);
  const readout=document.createElement('p');readout.id='route-chart-readout';readout.className='route-chart-readout';host.append(readout);
  const slider=document.createElement('input');slider.type='range';slider.min='0';slider.max=String(routeTrack.length-1);slider.value='0';slider.setAttribute('aria-label','거리 위치 선택');host.append(slider);slider.addEventListener('input',()=>updateRouteCursor(Number(slider.value),total,left,right));updateRouteCursor(0,total,left,right);
}
function updateRouteCursor(index,total,left=66,right=588){
  const point=routeTrack[index];if(!point)return;const x=left+point.cumulativeDistanceMeters/Math.max(1,total)*(right-left),cursor=$('#route-chart-cursor');cursor?.setAttribute('x1',x.toFixed(1));cursor?.setAttribute('x2',x.toFixed(1));const readout=$('#route-chart-readout'),rate=(activeDetailWorkout?.heartRate||[]).reduce((best,sample)=>{const gap=Math.abs(Date.parse(sample.timestamp||'')-point.timestamp);return point.timestamp!==null&&gap<best.gap?{gap,value:sample.beatsPerMinute}:best;},{gap:60_001,value:null});readout.textContent=`${displayDistance(point.cumulativeDistanceMeters)} · 고도 ${point.altitudeMeters==null?'—':`${Math.round(point.altitudeMeters)} m`} · 심박 ${rate.gap<=60_000?`${Math.round(rate.value)} bpm`:'—'} · 속도 ${point.speedKilometersPerHour==null?'—':`${point.speedKilometersPerHour.toFixed(1)} km/h`}`;const mapPoint=projectRoute(routeTrack,600,260)?.[index];const marker=$('#route-cursor');if(marker&&mapPoint){marker.setAttribute('cx',mapPoint.x.toFixed(1));marker.setAttribute('cy',mapPoint.y.toFixed(1));}if(typeof routeCursorMarker==='function')routeCursorMarker(point);
}
let replayStop=null;
function addRouteReplay(workout,track){
  if(replayStop)replayStop();$('#route-replay')?.remove();if(track.length<2)return;
  const section=document.createElement('section');section.id='route-replay';section.className='detail-data-section';
  const title=document.createElement('h3');title.textContent='경로 영상';
  const canvas=document.createElement('canvas');canvas.width=960;canvas.height=960;canvas.className='route-replay-canvas';canvas.setAttribute('aria-label','운동 경로 재생 영상');
  const controls=document.createElement('div');controls.className='replay-controls';
  const play=document.createElement('button'),save=document.createElement('button');play.type=save.type='button';play.className=save.className='button';play.textContent='경로 재생';save.textContent='영상 저장';
  const status=document.createElement('p');status.className='subnote';status.setAttribute('role','status');status.textContent='12초 경로 애니메이션 · 기기에서 영상 생성';
  controls.append(play,save);section.append(title,canvas,controls,status);$('#detail-route-section').after(section);
  const points=projectRoute(track,960,700,70),ctx=canvas.getContext('2d'),total=track.at(-1).cumulativeDistanceMeters;
  const frame=(progress)=>{const index=Math.min(track.length-1,Math.max(0,track.findIndex(p=>p.cumulativeDistanceMeters>=progress*total)));ctx.fillStyle='#142b26';ctx.fillRect(0,0,960,960);ctx.lineJoin=ctx.lineCap='round';
    const path=(end,color,width)=>{ctx.beginPath();points.slice(0,end+1).forEach((p,i)=>i?ctx.lineTo(p.x,p.y+80):ctx.moveTo(p.x,p.y+80));ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();};
    path(points.length-1,'#36584d',8);path(index,'#64e5a3',10);const point=points[index];ctx.beginPath();ctx.arc(point.x,point.y+80,13,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.fillStyle='#e9fff5';ctx.textAlign='center';ctx.font='600 30px sans-serif';ctx.fillText(workout.activityTypeName||'운동',480,60);ctx.font='700 56px sans-serif';ctx.fillText(displayDistance(track[index].cumulativeDistanceMeters),480,840);ctx.font='400 25px sans-serif';ctx.fillText(`${Math.round(progress*100)}% · ${displayDuration(workout.durationSeconds)} · 아기장수우투리`,480,902);
    const slider=$('#detail-combined-chart input[type=range]');if(slider){slider.value=String(index);slider.dispatchEvent(new Event('input'));}
  };
  let animation=0,recorder=null,stream=null;const stop=()=>{cancelAnimationFrame(animation);if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());play.disabled=save.disabled=false;};replayStop=stop;
  const run=(record)=>{
    stop();const chunks=[];let mime='';
    if(record){if(!window.MediaRecorder||!canvas.captureStream){status.textContent='이 브라우저는 영상 저장을 지원하지 않습니다. 경로 재생은 사용할 수 있습니다.';return;}
      mime=['video/mp4','video/webm;codecs=vp9','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));if(!mime){status.textContent='저장 가능한 영상 형식이 없습니다. 다른 브라우저에서 시도해 주세요.';return;}
      try{stream=canvas.captureStream(30);recorder=new MediaRecorder(stream,{mimeType:mime});recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>{status.textContent='영상을 저장하지 못했습니다. 다시 시도해 주세요.';stop();};recorder.onstop=()=>{stream?.getTracks().forEach(t=>t.stop());if(!chunks.length)return;const blob=new Blob(chunks,{type:mime}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`wuturi-route-${workout.startDate.slice(0,10)}.${mime.includes('mp4')?'mp4':'webm'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='경로 영상 저장 완료';};recorder.start();}catch(error){stop();status.textContent=`영상 저장 실패: ${error.message}`;return;}}
    play.disabled=save.disabled=true;status.textContent=record?'영상 생성 중 · 약 12초':'경로 재생 중';const start=performance.now();
    const tick=(now)=>{const progress=Math.min(1,(now-start)/12000);frame(progress);if(progress<1)animation=requestAnimationFrame(tick);else{if(recorder?.state==='recording')recorder.stop();play.disabled=save.disabled=false;if(!record)status.textContent='재생 완료';}};animation=requestAnimationFrame(tick);
  };
  play.addEventListener('click',()=>run(false));save.addEventListener('click',()=>run(true));frame(0);
}
function displaySplitTime(seconds){if(!Number.isFinite(seconds)||seconds<=0)return'—';const rounded=Math.round(seconds),hours=Math.floor(rounded/3600),minutes=Math.floor(rounded%3600/60),remainder=rounded%60;return hours?`${hours}:${String(minutes).padStart(2,'0')}:${String(remainder).padStart(2,'0')}`:`${minutes}:${String(remainder).padStart(2,'0')}`;}
function renderRouteAnalysis(workout,analysis){
  const section=$('#detail-route-analysis'),host=$('#detail-route-analysis-metrics'),quality=$('#detail-route-quality'),table=$('#detail-splits');section.hidden=analysis.validPointCount<2;host.replaceChildren();table.replaceChildren();if(section.hidden)return;
  const values=[['GPS 거리',displayDistance(analysis.distanceMeters)],['경과시간',analysis.elapsedSeconds?displayDuration(analysis.elapsedSeconds):'시각 미기록'],['누적 상승',analysis.elevationGainMeters===null?'미기록':`+${Math.round(analysis.elevationGainMeters)} m`],['누적 하강',analysis.elevationLossMeters===null?'미기록':`−${Math.round(analysis.elevationLossMeters)} m`],['고도 범위',analysis.minimumAltitudeMeters===null?'미기록':`${Math.round(analysis.minimumAltitudeMeters)}–${Math.round(analysis.maximumAltitudeMeters)} m`]];
  values.forEach(([label,value])=>{const row=document.createElement('div');row.className='analysis-row';row.innerHTML='<span></span><strong></strong>';row.children[0].textContent=label;row.children[1].textContent=value;host.append(row);});
  const gapNote=analysis.timeGapCount?` · 10분 초과 시각 공백 ${analysis.timeGapCount}개가 포함된 구간의 시간·페이스·심박은 제외했습니다`:'';
  quality.textContent=`유효 GPS ${analysis.validPointCount.toLocaleString('ko-KR')}점 · 좌표·시각 이상 또는 55 m/s 초과 ${analysis.rejectedPointCount}점 제외${gapNote}. 원본 기록은 변경하지 않았습니다.`;
  if(!analysis.splits.length){const empty=document.createElement('p');empty.className='empty-row';empty.textContent='100 m 이상 구간을 계산할 경로 기록이 없습니다.';table.append(empty);return;}
  const isCycling=/Cycling|사이클|자전거/i.test(`${workout.activityTypeIdentifier} ${workout.activityTypeName}`),columns=['구간','거리','시간',isCycling?'속도':'페이스','심박'];
  const heading=document.createElement('div');heading.className='split-row split-heading';heading.setAttribute('role','row');columns.forEach((label)=>{const cell=document.createElement('span');cell.setAttribute('role','columnheader');cell.textContent=label;heading.append(cell);});table.append(heading);
  analysis.splits.forEach((split)=>{const row=document.createElement('div');row.className='split-row';row.setAttribute('role','row');const cells=[split.isPartial?'마지막':String(split.index),displayDistance(split.distanceMeters),displaySplitTime(split.elapsedSeconds),isCycling?(split.averageSpeedKilometersPerHour===null?'—':`${split.averageSpeedKilometersPerHour.toFixed(1)} km/h`):(split.averagePaceSecondsPerKilometer===null?'—':displayPaceValue(split.averagePaceSecondsPerKilometer)),split.averageHeartRate===null?'—':`${Math.round(split.averageHeartRate)} bpm`];cells.forEach((value)=>{const cell=document.createElement('span');cell.setAttribute('role','cell');cell.textContent=value;row.append(cell);});table.append(row);});
}
function dateRange(days,offset=0){const end=new Date();end.setHours(0,0,0,0);end.setDate(end.getDate()+1-offset*days);const start=new Date(end);start.setDate(start.getDate()-days);return{start:localDateKey(start),end:localDateKey(end)};}
function metricItem(label,value,unit){const item=document.createElement('div');item.className='metric-value';const title=document.createElement('span');title.className='metric-label';title.textContent=label;const number=document.createElement('span');number.className='metric-number';const figure=document.createElement('span');figure.textContent=value;const suffix=document.createElement('small');suffix.textContent=unit;number.append(figure,suffix);item.append(title,number);return item;}
function renderCalendarDay(date,workouts){
  const host=$('#calendar-day-records');host.replaceChildren();const heading=document.createElement('strong');heading.textContent=date.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'});host.append(heading);
  if(!workouts.length){const empty=document.createElement('p');empty.textContent='이 날 저장된 운동이 없습니다.';host.append(empty);return;}
  workouts.forEach((workout)=>{const button=document.createElement('button');button.type='button';button.className='calendar-workout';button.innerHTML='<span></span><strong></strong><small></small>';button.children[0].textContent=new Date(workout.startDate).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});button.children[1].textContent=workout.activityTypeName;button.children[2].textContent=`${displayDuration(workout.durationSeconds)} · ${displayWorkoutDistance(workout)}`;button.addEventListener('click',()=>showWorkoutDetail(workout));host.append(button);});
}
function renderMonthCalendar(byDay,year,month){
  const grid=$('#month-calendar');grid.replaceChildren();
  const first=new Date(year,month,1),offset=(first.getDay()+6)%7,days=new Date(year,month+1,0).getDate(),today=new Date();today.setHours(0,0,0,0);
  for(let cellIndex=0;cellIndex<Math.ceil((offset+days)/7)*7;cellIndex++){
    const day=cellIndex-offset+1;if(day<1||day>days){const blank=document.createElement('span');blank.className='month-calendar-blank';blank.setAttribute('role','gridcell');grid.append(blank);continue;}
    const date=new Date(year,month,day),key=localDateKey(date),workouts=byDay.get(key)||[],cell=document.createElement('button');cell.type='button';cell.className='month-calendar-day';cell.dataset.date=key;cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`${date.toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'})}, 운동 ${workouts.length}회`);cell.setAttribute('aria-pressed','false');cell.disabled=date>today;
    if(key===localDateKey(today))cell.classList.add('is-today');if(workouts.length)cell.classList.add('has-workout');
    const number=document.createElement('span');number.className='month-calendar-number';number.textContent=String(day);cell.append(number);
    if(workouts.length){const count=document.createElement('span');count.className='month-calendar-count';count.textContent=`${workouts.length}회`;cell.append(count);const kinds=[...new Set(workouts.map((item)=>item.activityTypeName||'운동'))].slice(0,2);kinds.forEach((name)=>{const sport=document.createElement('span');sport.className='month-calendar-sport';sport.dataset.kind=/걷|walk/i.test(name)?'walk':/달리|run/i.test(name)?'run':/사이클|자전거|cycle|bike/i.test(name)?'cycle':/등산|하이킹|hik/i.test(name)?'hike':/수영|swim/i.test(name)?'swim':'other';sport.textContent=name;cell.append(sport);});if(new Set(workouts.map((item)=>item.activityTypeName||'운동')).size>2){const more=document.createElement('span');more.className='month-calendar-more';more.textContent='+';cell.append(more);}}
    cell.addEventListener('click',()=>{grid.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed','false');cell.setAttribute('aria-pressed','true');renderCalendarDay(date,workouts);});grid.append(cell);
  }
}
function renderWorkoutCalendar(){
  const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth(),monthWorkouts=data.workouts.filter((workout)=>{const date=new Date(workout.startDate);return date.getFullYear()===year&&date.getMonth()===month;});
  $('#calendar-month-title').textContent=calendarMonth.toLocaleDateString('ko-KR',{year:'numeric',month:'long'});
  $('#calendar-month-count').textContent=`${monthWorkouts.length}회`;
  $('#calendar-month-duration').textContent=monthWorkouts.length?`총 ${displayDuration(monthWorkouts.reduce((sum,workout)=>sum+workout.durationSeconds,0))}`:'운동 기록 없음';
  const byDay=new Map();data.workouts.forEach((workout)=>{const key=localDateKey(new Date(workout.startDate));byDay.set(key,[...(byDay.get(key)||[]),workout]);});
  renderMonthCalendar(byDay,year,month);
  const end=new Date(year,month+1,0),anchor=new Date(end);anchor.setDate(end.getDate()-105);anchor.setHours(0,0,0,0);anchor.setDate(anchor.getDate()-(anchor.getDay()+6)%7);
  const grid=$('#activity-heatmap'),labels=$('#heatmap-months');grid.replaceChildren();labels.replaceChildren();
  for(let week=0;week<16;week++){
    const monday=new Date(anchor);monday.setDate(anchor.getDate()+week*7);
    const monthStart=[...Array(7)].map((_,day)=>{const date=new Date(monday);date.setDate(monday.getDate()+day);return date;}).find((date)=>date.getDate()===1);
    if(monthStart||week===0){const label=document.createElement('span');label.textContent=(monthStart||monday).toLocaleDateString('ko-KR',{month:'numeric'});label.style.gridColumn=String(week+1);labels.append(label);}
    for(let day=0;day<7;day++){
      const date=new Date(monday);date.setDate(monday.getDate()+day);const workouts=byDay.get(localDateKey(date))||[];const cell=document.createElement('button');cell.type='button';cell.className='heatmap-day';cell.dataset.level=String(Math.min(4,workouts.length));cell.setAttribute('role','gridcell');cell.setAttribute('aria-label',`${date.toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'})}, 운동 ${workouts.length}회`);cell.title=cell.getAttribute('aria-label');cell.disabled=date>end||date>new Date();cell.addEventListener('click',()=>renderCalendarDay(date,workouts));grid.append(cell);
    }
  }
  const now=new Date(),selectedDay=year===now.getFullYear()&&month===now.getMonth()?now:new Date(year,month+1,0);$(`#month-calendar [data-date="${localDateKey(selectedDay)}"]`)?.setAttribute('aria-pressed','true');renderCalendarDay(selectedDay,byDay.get(localDateKey(selectedDay))||[]);
  $('#month-calendar-panel').hidden=calendarMode!=='month';$('#heatmap-panel').hidden=calendarMode!=='heatmap';
  $('#calendar-mode').querySelectorAll('[data-calendar-mode]').forEach((button)=>{const selected=button.dataset.calendarMode===calendarMode;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
}
function renderAnalysis(){
  const range=dateRange(analysisDays),priorRange=dateRange(analysisDays,1),current=summarizeRange(data,range.start,range.end);const host=$('#analysis-metrics');host.replaceChildren();
  host.append(metricItem('운동',String(current.workoutCount),'회'),metricItem('운동 시간',String(Math.round(current.durationSeconds/60)),'분'),metricItem('걸음',current.stepCount===null?'—':prettyNumber(current.stepCount),'보'),metricItem('운동 거리',current.distanceMeters?displayDistance(current.distanceMeters):'—',''));
  const types=$('#activity-types');types.replaceChildren();if(!current.activityDurations.length){const empty=document.createElement('p');empty.className='empty-row';empty.textContent='선택 기간에 운동 기록이 없습니다.';types.append(empty);}else current.activityDurations.forEach((item)=>{const row=document.createElement('div');row.className='analysis-row';row.innerHTML='<span></span><strong></strong><small></small>';row.children[0].textContent=item.name;row.children[1].textContent=`${item.count}회`;row.children[2].textContent=displayDuration(item.durationSeconds);types.append(row);});
  const personal=$('#personal-records');personal.replaceChildren();const records=calculatePersonalRecords(data.workouts);if(!records.length){const empty=document.createElement('p');empty.className='empty-row';empty.textContent='거리와 시간이 있는 운동 기록을 가져오면 종목별 개인 기록을 계산합니다.';personal.append(empty);}else records.forEach((record)=>{const row=document.createElement('div');row.className='analysis-row';const value=record.metric==='longestDuration'?displayDuration(record.value):record.metric==='longestDistance'?displayDistance(record.value):record.metric==='fastestAveragePace'?`${Math.floor(record.value/60)}′${String(Math.round(record.value%60)).padStart(2,'0')}″ /km`:`${record.value.toFixed(1)} km/h`;row.innerHTML='<span></span><strong></strong><small></small>';row.children[0].textContent=`${record.activityTypeName} · ${record.label}`;row.children[1].textContent=value;row.children[2].textContent='전체 기록';personal.append(row);});
  renderWorkoutCalendar();
  const max=Number($('#max-heart-rate').value||localStorage.getItem('wuturi-max-heart-rate')||0);if(max>0)$('#max-heart-rate').value=String(max);const load=calculateHeartRateLoad(current.workouts,max);const hr=$('#heart-rate-load');hr.replaceChildren();
  if(!max){const note=document.createElement('p');note.className='empty-row';note.textContent='최대 심박수를 입력하면 심박 구간을 계산합니다. 기본값이나 나이 추정치는 사용하지 않습니다.';hr.append(note);}else if(!load.coverageSeconds){const note=document.createElement('p');note.className='empty-row';note.textContent='이 기간에 부하를 계산할 수 있는 심박 표본이 없습니다.';hr.append(note);}else{const score=document.createElement('p');score.className='hr-score';score.textContent=`훈련 부하 ${load.score.toFixed(1)}점 · ${displayDuration(load.coverageSeconds)} 관측`;hr.append(score);load.zones.slice(1).forEach((seconds,index)=>{const row=document.createElement('div');row.className='analysis-row';row.innerHTML='<span></span><strong></strong>';row.children[0].textContent=`Z${index+1}`;row.children[1].textContent=displayDuration(seconds);hr.append(row);});}
}
function currentCoachRanges(period){
  const today=new Date();today.setHours(0,0,0,0);let start,end,previousStart,previousEnd;
  if(period==='daily'){start=today;end=new Date(today);end.setDate(end.getDate()+1);previousStart=new Date(today);previousStart.setDate(previousStart.getDate()-1);previousEnd=today;}
  else if(period==='weekly'){start=new Date(today);start.setDate(today.getDate()-(today.getDay()+6)%7);end=new Date(start);end.setDate(end.getDate()+7);previousStart=new Date(start);previousStart.setDate(previousStart.getDate()-7);previousEnd=start;}
  else{start=new Date(today.getFullYear(),today.getMonth(),1);end=new Date(today.getFullYear(),today.getMonth()+1,1);previousStart=new Date(today.getFullYear(),today.getMonth()-1,1);previousEnd=start;}
  return{start:localDateKey(start),end:localDateKey(end),previousStart:localDateKey(previousStart),previousEnd:localDateKey(previousEnd)};
}
function renderCoachReport(report){
  $('#coach-summary').textContent=report.summary;const host=$('#coach-findings');host.replaceChildren();[['좋았던 점',report.positives],['살펴볼 점',report.improvements]].forEach(([title,items])=>{if(!items.length)return;const section=document.createElement('div');section.className='coach-finding';const heading=document.createElement('strong');heading.textContent=title;const list=document.createElement('ul');items.forEach((text)=>{const item=document.createElement('li');item.textContent=text;list.append(item);});section.append(heading,list);host.append(section);});
  $('#coach-next').textContent=`다음 활동 제안 · ${report.nextActivity}`;const evidence=$('#coach-evidence');evidence.replaceChildren();report.evidence.forEach((text)=>{const chip=document.createElement('span');chip.className='evidence-chip';chip.textContent=text;evidence.append(chip);});
}
function renderCoachHistory(){
  const host=$('#coach-history');host.replaceChildren();let reports=[];try{reports=JSON.parse(localStorage.getItem('wuturi-coach-history')||'[]');}catch{}if(!reports.length){const empty=document.createElement('p');empty.className='empty-row';empty.textContent='저장된 코칭 기록이 아직 없습니다.';host.append(empty);return;}
  reports.forEach((entry)=>{const button=document.createElement('button');button.type='button';button.className='history-row';const title=document.createElement('strong');title.textContent=`${entry.periodLabel} · ${entry.createdAt}`;const text=document.createElement('span');text.textContent=entry.report.summary;button.append(title,text);button.addEventListener('click',()=>renderCoachReport(entry.report));host.append(button);});
}
function generateCoach(){
  const range=currentCoachRanges(coachPeriod),current=summarizeRange(data,range.start,range.end),previous=summarizeRange(data,range.previousStart,range.previousEnd),goal=Number($('#step-goal').value||localStorage.getItem('wuturi-step-goal')||0)||null;const report=buildLocalCoachReport(current,previous,goal);renderCoachReport(report);const labels={daily:'오늘',weekly:'이번 주',monthly:'이번 달'};let history=[];try{history=JSON.parse(localStorage.getItem('wuturi-coach-history')||'[]');}catch{}history.unshift({period:coachPeriod,periodLabel:labels[coachPeriod],createdAt:new Date().toLocaleString('ko-KR'),report});localStorage.setItem('wuturi-coach-history',JSON.stringify(history.slice(0,12)));renderCoachHistory();
}

function renderWorkoutMonthSummary(){if(data.workouts.length){const latest=new Date(data.workouts.reduce((a,b)=>a.startDate>b.startDate?a:b).startDate);calendarMonth=new Date(latest.getFullYear(),latest.getMonth(),1);}const items=data.workouts.filter((workout)=>{const date=new Date(workout.startDate);return date.getFullYear()===calendarMonth.getFullYear()&&date.getMonth()===calendarMonth.getMonth();});$('#workout-month-label').textContent=calendarMonth.toLocaleDateString('ko-KR',{year:'numeric',month:'long'});$('#workout-month-count').textContent=`${items.length}회`;$('#workout-month-duration').textContent=`선택한 달 · 총 ${displayDuration(items.reduce((sum,workout)=>sum+workout.durationSeconds,0))}`;}
function render() { renderWeeklySummary(); renderWorkoutMonthSummary(); renderSteps(); renderWorkouts(); renderWorkoutTypeFilter(); renderFullWorkoutList(); renderRoutes(); if(!$('#analysis-view').hidden)renderAnalysis(); }
async function handleImport(files) {
  if (!files.length) return;
  let incoming = emptyData(); const parsedRoutes=[]; const problems=[]; let count=0;
  const addHealth = (health) => { incoming=mergeHealthData(incoming,health); };
  for (const file of files) {
    try {
      const lower=file.name.toLowerCase();
      if (lower.endsWith('.gpx')) { parsedRoutes.push(parseGPX(await file.text(),file.name)); count++; }
      else if (lower.endsWith('.xml')) { addHealth(parseHealthXML(await file.text())); count++; }
      else if (lower.endsWith('.zip')) {
        const archive=await readHealthExportZip(file),health=parseHealthXML(archive.xml),routes=[];
        for(const route of archive.routes)routes.push(parseGPX(await route.blob.text(),route.name));
        addHealth(health);parsedRoutes.push(...routes);count++;
      }
      else if (lower.endsWith('.json')) { addHealth(normalizeHealthExport(JSON.parse(await file.text()))); count++; }
      else problems.push(`${file.name}: 지원하지 않는 파일`);
    } catch (error) { problems.push(`${file.name}: ${error.message || '읽을 수 없음'}`); }
  }
  if (!count) { announce(problems[0] || '가져올 수 있는 파일이 없습니다.',true); return; }
  const oldRoutes = data.routeFiles || [];
  const byName = new Map(oldRoutes.map((route) => [route.name,route]));
  parsedRoutes.forEach((route) => byName.set(route.name,route));
  const routes=[...byName.values()];
  data=mergeHealthData(data,incoming);
  data.routeFiles=routes;
  data=attachRoutesToWorkouts(data,routes);
  const importedWorkoutIds=new Set(incoming.workouts.map((workout)=>workout.id));
  const importedRouteCount=Math.max(parsedRoutes.length,data.workouts.filter((workout)=>importedWorkoutIds.has(workout.id)&&workout.route?.length>1).length);
  let saved=true;
  try { await saveData(); }
  catch (error) { saved=false; announce(`가져온 내용은 화면에 표시되지만 기기에 저장하지 못했습니다: ${error.message}`,true); }
  render();
  const summary=`${count}개 파일 · 운동 ${incoming.workouts.length}개 · 활동 날짜 ${incoming.dailyActivity.length}일 · 경로 ${importedRouteCount}개${saved?' 저장':''}`;
  $('#import-status').textContent=problems.length ? `일부 파일을 건너뜀: ${problems[0]} · ${summary}` : `${saved?'건강 데이터 자동 반영 완료':'읽기는 완료, 기기 저장 실패'} · ${summary}`;
  if(saved)announce(`${count}개 파일을 읽고 기기에 저장했습니다.`);
}
function setView(name) {
  document.querySelectorAll('.tab').forEach((tab)=>tab.classList.toggle('is-active',tab.dataset.view===name));
  document.querySelectorAll('.view').forEach((view)=>{view.hidden=view.id!==`${name}-view`;});
  if(name==='workouts')renderFullWorkoutList();
  if(name==='analysis')renderAnalysis();
  if(name==='coach')renderCoachHistory();
}
function formatStampTime(workout) { return displayDuration(workout.durationSeconds); }
function drawRoute(ctx, points, x,y,w,h,color) {
  if (!points || points.length < 2) return;
  const lats=points.map((point)=>point.latitude), lons=points.map((point)=>point.longitude);
  let minLat=Math.min(...lats), maxLat=Math.max(...lats), minLon=Math.min(...lons), maxLon=Math.max(...lons);
  if (maxLat-minLat<1e-7){minLat-=.0001;maxLat+=.0001;} if(maxLon-minLon<1e-7){minLon-=.0001;maxLon+=.0001;}
  const pad=Math.min(w,h)*.13;
  const scale=Math.min((w-pad*2)/(maxLon-minLon),(h-pad*2)/(maxLat-minLat));
  const usedW=(maxLon-minLon)*scale,usedH=(maxLat-minLat)*scale;
  const ox=x+(w-usedW)/2,oy=y+(h-usedH)/2;
  ctx.save(); ctx.beginPath();
  points.forEach((point,index)=>{ const px=ox+(point.longitude-minLon)*scale, py=oy+(maxLat-point.latitude)*scale; index?ctx.lineTo(px,py):ctx.moveTo(px,py); });
  ctx.strokeStyle=color;ctx.lineWidth=Math.max(3,w*.025);ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();
  const first={x:ox+(points[0].longitude-minLon)*scale,y:oy+(maxLat-points[0].latitude)*scale};
  const last=points.at(-1);const end={x:ox+(last.longitude-minLon)*scale,y:oy+(maxLat-last.latitude)*scale};
  ctx.fillStyle=color;for(const dot of [first,end]){ctx.beginPath();ctx.arc(dot.x,dot.y,Math.max(4,w*.035),0,Math.PI*2);ctx.fill();}
  ctx.restore();
}
const stampLayouts=[['classic','세로 카드',.74],['clear','투명 세로',.74],['wide','가로 배치',2.3],['route','경로 중심',1],['grid','격자 배치',1.15],['poster','기록 포스터',.85],['compact','미니 배치',1.8],['bold','숫자 강조',1.1]];
function stampBounds(canvas){
  const ratio=stampLayouts.find(item=>item[0]===stampLayout)[2];
  const width=Math.min(canvas.width*.94,canvas.height*.94*ratio,canvas.width*.45*stamp.scale);
  return {width,height:width/ratio};
}
function drawPhoto() {
  if(!photoImage||!selectedWorkout)return;
  const canvas=$('#photo-canvas'),scale=Math.min(1,1600/Math.max(photoImage.naturalWidth,photoImage.naturalHeight));
  canvas.width=Math.round(photoImage.naturalWidth*scale);canvas.height=Math.round(photoImage.naturalHeight*scale);
  const ctx=canvas.getContext('2d');ctx.drawImage(photoImage,0,0,canvas.width,canvas.height);
  const {width:w,height:h}=stampBounds(canvas);
  stamp.x=Math.max(0,Math.min(stamp.x??canvas.width*.5,canvas.width-w));stamp.y=Math.max(0,Math.min(stamp.y??canvas.height*.4,canvas.height-h));
  ctx.save();ctx.translate(stamp.x,stamp.y);
  const clear=stampLayout==='clear'||$('#stamp-transparent').checked;
  if(!clear){ctx.fillStyle='rgba(18,27,25,.74)';roundedRect(ctx,0,0,w,h,w*.035);ctx.fill();}
  ctx.shadowColor='rgba(0,0,0,.7)';ctx.shadowBlur=clear?w*.025:0;ctx.shadowOffsetY=clear?1:0;
  const values=[displayWorkoutDistance(selectedWorkout),displayPace(selectedWorkout)||'미기록',formatStampTime(selectedWorkout)],labels=['DISTANCE','PACE','TIME'];
  const text=(value,x,y,size,align='center',muted=false)=>{ctx.textAlign=align;ctx.fillStyle=muted?'#dce9e5':'#fff';ctx.font=`${muted?500:700} ${size}px -apple-system,BlinkMacSystemFont,sans-serif`;ctx.fillText(value,x,y,w*.9);};
  const metric=(i,x,y,size=w*.075)=>{text(labels[i],x,y,size*.5,'center',true);text(values[i],x,y+size*1.35,size);};
  const route=(x,y,rw,rh)=>drawRoute(ctx,selectedWorkout.route,x,y,rw,rh,$('#route-color').value);
  if(stampLayout==='wide'||stampLayout==='compact'){
    values.forEach((_,i)=>metric(i,w*(i+.5)/3,h*.18,w*(stampLayout==='compact'?.067:.072)));route(w*.08,h*.52,w*.84,h*.42);
  }else if(stampLayout==='route'){
    route(w*.08,h*.04,w*.84,h*.59);values.forEach((_,i)=>metric(i,w*(i+.5)/3,h*.72,w*.065));
  }else if(stampLayout==='grid'){
    metric(0,w*.27,h*.17);metric(1,w*.73,h*.17);metric(2,w*.27,h*.64);route(w*.53,h*.48,w*.41,h*.43);
  }else if(stampLayout==='poster'||stampLayout==='bold'){
    text('MY WORKOUT',w*.5,h*.12,w*.045,'center',true);text(values[0],w*.5,h*.31,w*.13);route(w*.12,h*.35,w*.76,h*.36);metric(1,w*.28,h*.79,w*.065);metric(2,w*.73,h*.79,w*.065);
  }else{
    metric(0,w*.5,h*.10,w*.10);metric(1,w*.5,h*.30,w*.085);metric(2,w*.5,h*.49,w*.085);route(w*.08,h*.69,w*.84,h*.27);
  }
  ctx.restore();
}
function roundedRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function renderPhotoState() {
  const ready=Boolean(photoImage&&selectedWorkout);
  $('#photo-stage').hidden=!ready;
  $('#editor-options').hidden=!ready;
  $('#photo-empty').hidden=ready;
  if(!ready) $('#photo-empty').querySelector('strong').innerHTML=photoImage?'사진을 선택했어요.<br>경로가 있는 운동을 골라주세요.':'사진과 운동 경로를 선택하면<br>합성 결과를 미리 볼 수 있어요.';
  if(ready) drawPhoto();
}
function setPhoto(file) {
  if (!file) return;
  if (selectedPhoto) URL.revokeObjectURL(selectedPhoto);
  selectedPhoto=URL.createObjectURL(file); photoImage=new Image(); photoImage.onload=()=>{
    stamp={x:null,y:null,scale:Number($('#stamp-size').value)/100};renderPhotoState();
  };photoImage.onerror=()=>announce('이 사진 파일을 열 수 없습니다.',true);photoImage.src=selectedPhoto;
}
function savePhoto() {
  const canvas=$('#photo-canvas');if(!canvas.width)return;
  canvas.toBlob((blob)=>{
    if(!blob){announce('이미지를 만들지 못했습니다.',true);return;}
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`wuturi-route-${selectedWorkout.startDate.slice(0,10)}.jpg`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);announce('경로 사진을 저장했습니다.');
  },'image/jpeg',.94);
}
stampLayouts.forEach(([id,name])=>{
  const button=document.createElement('button');button.type='button';button.className='stamp-layout-choice';button.dataset.layout=id;button.setAttribute('aria-pressed',String(id===stampLayout));
  const preview=document.createElement('span');preview.className='stamp-sample';preview.dataset.layout=id;preview.innerHTML='<b>10.01</b><i>6′18″ /km</i><svg viewBox="0 0 80 30" aria-hidden="true"><path d="M8 20L20 6 40 14 60 8 73 23 47 27 24 23Z" fill="none" stroke="#62e4a0" stroke-width="3"/></svg>';
  const label=document.createElement('span');label.textContent=name;button.append(preview,label);button.addEventListener('click',()=>{stampLayout=id;$('#stamp-layout-options').querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));drawPhoto();});$('#stamp-layout-options').append(button);
});
$('#import-button').addEventListener('click',()=>$('#health-files').click());
$('#health-files').addEventListener('change',async(event)=>{await handleImport([...event.target.files]);event.target.value='';});
document.querySelectorAll('.tab').forEach((tab)=>tab.addEventListener('click',()=>setView(tab.dataset.view)));
$('#route-select').addEventListener('change',(event)=>{selectedWorkout=data.workouts.find((workout)=>workout.id===event.target.value)||null;renderPhotoState();});
$('#photo-file').addEventListener('change',(event)=>setPhoto(event.target.files[0]));
$('#stamp-size').addEventListener('input',(event)=>{stamp.scale=Number(event.target.value)/100;$('#stamp-size-value').textContent=`${event.target.value}%`;if(photoImage)drawPhoto();});
$('#stamp-transparent').addEventListener('change',drawPhoto);
$('#route-color').addEventListener('input',()=>{if(photoImage)drawPhoto();});
$('#save-image').addEventListener('click',savePhoto);
$('#privacy-button').addEventListener('click',()=>$('#privacy-dialog').showModal());
$('#close-dialog').addEventListener('click',()=>$('#privacy-dialog').close());
$('#close-workout-dialog').addEventListener('click',()=>$('#workout-dialog').close());
$('#workout-search').addEventListener('input',renderFullWorkoutList);
$('#workout-type-filter').addEventListener('change',renderFullWorkoutList);
$('#analysis-period').addEventListener('click',(event)=>{const button=event.target.closest('button[data-days]');if(!button)return;analysisDays=Number(button.dataset.days);event.currentTarget.querySelectorAll('button').forEach((item)=>item.classList.toggle('selected',item===button));renderAnalysis();});
$('#coach-period').addEventListener('click',(event)=>{const button=event.target.closest('button[data-period]');if(!button)return;coachPeriod=button.dataset.period;event.currentTarget.querySelectorAll('button').forEach((item)=>item.classList.toggle('selected',item===button));});
$('#step-goal').value=localStorage.getItem('wuturi-step-goal')||'';
$('#step-goal').addEventListener('input',(event)=>localStorage.setItem('wuturi-step-goal',event.target.value));
$('#max-heart-rate').addEventListener('input',(event)=>{localStorage.setItem('wuturi-max-heart-rate',event.target.value);renderAnalysis();});
$('#generate-coach').addEventListener('click',generateCoach);
$('#export-button').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='wuturi-health-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),2000);
});
$('#clear-button').addEventListener('click',async()=>{
  if(!confirm('이 브라우저에 저장된 건강·운동 기록을 모두 지울까요?'))return;
  await clearData();data=emptyData();localStorage.removeItem('wuturi-coach-history');localStorage.removeItem('wuturi-step-goal');localStorage.removeItem('wuturi-max-heart-rate');$('#step-goal').value='';$('#max-heart-rate').value='';render();renderCoachHistory();$('#import-status').textContent='기기 안의 기록을 지웠습니다.';announce('이 기기의 기록을 지웠습니다.');
});
const canvas=$('#photo-canvas');
let drag=null;
canvas.addEventListener('pointerdown',(event)=>{
  const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height;
  const {width,height}=stampBounds(canvas);
  if(x>=stamp.x&&x<=stamp.x+width&&y>=stamp.y&&y<=stamp.y+height){drag={x,y,stampX:stamp.x,stampY:stamp.y};canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',(event)=>{if(!drag)return;const rect=canvas.getBoundingClientRect();stamp.x=drag.stampX+(event.clientX-rect.left)*canvas.width/rect.width-drag.x;stamp.y=drag.stampY+(event.clientY-rect.top)*canvas.height/rect.height-drag.y;drawPhoto();});
canvas.addEventListener('pointerup',()=>{drag=null;});canvas.addEventListener('pointercancel',()=>{drag=null;});
setView('workouts');
try { data=await readData(); if(!Array.isArray(data.routeFiles))data.routeFiles=[]; data=attachRoutesToWorkouts(data,data.routeFiles);render(); }
catch(error){$('#import-status').textContent=`기기 저장소를 사용할 수 없습니다. ${error.message}`;render();}
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
$('#calendar-previous').addEventListener('click',()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()-1,1);renderWorkoutCalendar();});
$('#calendar-next').addEventListener('click',()=>{calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,1);renderWorkoutCalendar();});
$('#calendar-mode').addEventListener('click',(event)=>{const button=event.target.closest('[data-calendar-mode]');if(!button)return;calendarMode=button.dataset.calendarMode;renderWorkoutCalendar();});
$('#naver-map-key').value=localStorage.getItem('wuturi-naver-map-keyid')||'';
$('#save-map-key').addEventListener('click',()=>{const key=$('#naver-map-key').value.trim();if(key)localStorage.setItem('wuturi-naver-map-keyid',key);else localStorage.removeItem('wuturi-naver-map-keyid');naverMapsPromise=undefined;$('#privacy-dialog').close();announce(key?'네이버 지도 키를 이 기기에 저장했습니다.':'네이버 지도 연결을 해제했습니다.');});
$('#close-workout-dialog-bottom').addEventListener('click',()=>$('#workout-dialog').close());
