const maxXMLBytes = 768 * 1024 * 1024;
const maxRouteBytes = 256 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readEntry(archive, entry) {
  if (entry.flags & 1) throw new Error('암호화된 ZIP은 열 수 없습니다.');
  if (entry.uncompressedSize > (entry.isXML ? maxXMLBytes : maxRouteBytes)) throw new Error(`${entry.name}: 압축 해제 크기가 너무 큽니다.`);
  const header = new DataView(await archive.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.name}: ZIP 파일이 손상되었습니다.`);
  const dataStart = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const compressedEnd = dataStart + entry.compressedSize;
  if (compressedEnd > archive.size || dataStart < entry.localOffset) throw new Error(`${entry.name}: ZIP 파일이 손상되었습니다.`);
  const compressed = archive.slice(dataStart, compressedEnd);
  let bytes;
  if (entry.method === 0) bytes = new Uint8Array(await compressed.arrayBuffer());
  else if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 Safari에서는 ZIP 자동 해제를 지원하지 않습니다. Files 앱에서 압축을 푼 뒤 export.xml을 선택해 주세요.');
    try { bytes = new Uint8Array(await new Response(compressed.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
    catch { throw new Error(`${entry.name}: 압축 해제에 실패했습니다.`); }
  } else throw new Error(`${entry.name}: 지원하지 않는 ZIP 압축 방식입니다.`);
  if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc) throw new Error(`${entry.name}: ZIP 내부 데이터 검증에 실패했습니다.`);
  return new Blob([bytes], { type: 'application/octet-stream' });
}

export async function readHealthExportZip(archive) {
  const tailStart = Math.max(0, archive.size - 65_557);
  const tail = new DataView(await archive.slice(tailStart).arrayBuffer());
  let endOffset = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) === 0x06054b50 && offset + 22 + tail.getUint16(offset + 20, true) === tail.byteLength) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('Apple 건강 내보내기 ZIP의 목차를 찾지 못했습니다.');
  if (tail.getUint16(endOffset + 4, true) !== 0 || tail.getUint16(endOffset + 6, true) !== 0) throw new Error('분할된 ZIP 파일은 열 수 없습니다.');
  const entryCount = tail.getUint16(endOffset + 10, true), centralOffset = tail.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new Error('64비트 ZIP 형식은 지원하지 않습니다.');
  const central = new DataView(await archive.slice(centralOffset, tailStart + endOffset).arrayBuffer());
  const decoder = new TextDecoder('utf-8');
  const output = { xml: null, routes: [] };
  let offset = 0, routeBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > central.byteLength || central.getUint32(offset, true) !== 0x02014b50) throw new Error('Apple 건강 내보내기 ZIP의 목차가 손상되었습니다.');
    const flags = central.getUint16(offset + 8, true), method = central.getUint16(offset + 10, true), crc = central.getUint32(offset + 16, true);
    const compressedSize = central.getUint32(offset + 20, true), uncompressedSize = central.getUint32(offset + 24, true);
    const nameLength = central.getUint16(offset + 28, true), extraLength = central.getUint16(offset + 30, true), commentLength = central.getUint16(offset + 32, true);
    const localOffset = central.getUint32(offset + 42, true), nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > central.byteLength || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error('64비트 또는 손상된 ZIP 항목은 지원하지 않습니다.');
    const name = decoder.decode(new Uint8Array(central.buffer, central.byteOffset + offset + 46, nameLength));
    const isXML = name === 'export.xml', isRoute = /^workout-routes\/[^/]+\.gpx$/i.test(name);
    if (isXML || isRoute) {
      if (isXML && output.xml) throw new Error('ZIP 안에 export.xml이 두 개 이상 있습니다.');
      if (isRoute) { routeBytes += uncompressedSize; if (routeBytes > maxRouteBytes) throw new Error('GPX 경로 파일의 전체 압축 해제 크기가 너무 큽니다.'); }
      const entry = { name, flags, method, crc, compressedSize, uncompressedSize, localOffset, isXML };
      const blob = await readEntry(archive, entry);
      if (isXML) output.xml = await blob.text(); else output.routes.push({ name: name.slice('workout-routes/'.length), blob });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  if (!output.xml) throw new Error('ZIP 안에서 export.xml을 찾지 못했습니다.');
  return output;
}
