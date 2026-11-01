import test from 'node:test';
import assert from 'node:assert/strict';
import { readHealthExportZip } from '../archive.mjs';

const crcTable = Uint32Array.from({ length:256 },(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);return(crc^0xffffffff)>>>0;}
function u16(view,offset,value){view.setUint16(offset,value,true);}
function u32(view,offset,value){view.setUint32(offset,value,true);}
async function createZip(entries){
  const local=[],central=[];let offset=0;
  for(const {name,text,method=0} of entries){
    const nameBytes=new TextEncoder().encode(name),plain=new TextEncoder().encode(text);
    const compressed=method===8?new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()):plain;
    const checksum=crc32(plain),localHeader=new Uint8Array(30),localView=new DataView(localHeader.buffer);
    u32(localView,0,0x04034b50);u16(localView,4,20);u16(localView,6,0x800);u16(localView,8,method);u32(localView,14,checksum);u32(localView,18,compressed.length);u32(localView,22,plain.length);u16(localView,26,nameBytes.length);
    local.push(localHeader,nameBytes,compressed);
    const centralHeader=new Uint8Array(46),centralView=new DataView(centralHeader.buffer);
    u32(centralView,0,0x02014b50);u16(centralView,4,20);u16(centralView,6,20);u16(centralView,8,0x800);u16(centralView,10,method);u32(centralView,16,checksum);u32(centralView,20,compressed.length);u32(centralView,24,plain.length);u16(centralView,28,nameBytes.length);u32(centralView,42,offset);
    central.push(centralHeader,nameBytes);offset+=localHeader.length+nameBytes.length+compressed.length;
  }
  const centralBytes=new Blob(central),end=new Uint8Array(22),endView=new DataView(end.buffer);
  u32(endView,0,0x06054b50);u16(endView,8,entries.length);u16(endView,10,entries.length);u32(endView,12,centralBytes.size);u32(endView,16,offset);
  return new Blob([...local,centralBytes,end]);
}

test('reads compressed Apple Health XML and stored workout route from one ZIP',async()=>{
  const archive=await createZip([
    {name:'export.xml',text:'<HealthData/>',method:8},
    {name:'workout-routes/route_2026-10-31.gpx',text:'<gpx/>',method:0},
    {name:'other.txt',text:'ignored'}
  ]);
  const result=await readHealthExportZip(archive);
  assert.equal(result.xml,'<HealthData/>');
  assert.equal(result.routes.length,1);
  assert.equal(result.routes[0].name,'route_2026-10-31.gpx');
  assert.equal(await result.routes[0].blob.text(),'<gpx/>');
});

test('rejects missing Apple Health XML and corrupt archive contents',async()=>{
  await assert.rejects(readHealthExportZip(await createZip([{name:'notes.txt',text:'no health data'}])),/export.xml 또는 내보내기.xml을 찾지 못했습니다/);
  const archive=await createZip([{name:'export.xml',text:'<HealthData/>',method:8}]);
  const damaged=new Uint8Array(await archive.arrayBuffer());damaged[40]^=0xff;
  await assert.rejects(readHealthExportZip(new Blob([damaged])),/압축 해제에 실패|ZIP 내부 데이터 검증/);
});

for(const name of ['내보내기.xml','내보내기.xml'.normalize('NFD'),'apple_health_export/export.xml','건강 내보내기/내보내기.xml','EXPORT.XML']){
  test(`recognizes localized or nested health XML: ${name}`,async()=>{
    const archive=await createZip([{name,text:'<HealthData/>',method:8},{name:'건강 내보내기/workout-routes/route.gpx',text:'<gpx/>'}]);
    const result=await readHealthExportZip(archive);assert.equal(result.xml,'<HealthData/>');assert.equal(result.routes[0].name,'route.gpx');
  });
}
test('rejects ambiguous health XML aliases instead of choosing silently',async()=>{
  await assert.rejects(readHealthExportZip(await createZip([{name:'export.xml',text:'<HealthData/>'},{name:'내보내기.xml',text:'<HealthData/>'}])),/두 개 이상/);
});
