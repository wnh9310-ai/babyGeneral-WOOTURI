const isCoordinate = (point) => Number.isFinite(point?.latitude)
  && Number.isFinite(point?.longitude)
  && Math.abs(point.latitude) <= 90
  && Math.abs(point.longitude) <= 180;

export function calculateRouteDistanceMeters(points) {
  const valid = (Array.isArray(points) ? points : []).filter(isCoordinate);
  if (valid.length < 2) return null;
  const earthRadiusMeters = 6_371_008.8;
  let distance = 0;
  for (let index = 1; index < valid.length; index += 1) {
    const previous = valid[index - 1];
    const current = valid[index];
    const lat1 = previous.latitude * Math.PI / 180;
    const lat2 = current.latitude * Math.PI / 180;
    const deltaLat = lat2 - lat1;
    const deltaLon = (current.longitude - previous.longitude) * Math.PI / 180;
    const arc = Math.sin(deltaLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    distance += 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, arc)));
  }
  return distance > 0 ? distance : null;
}

export function routeElapsedSeconds(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = Date.parse(points.find((point) => Number.isFinite(Date.parse(point?.timestamp || '')))?.timestamp || '');
  const last = Date.parse([...points].reverse().find((point) => Number.isFinite(Date.parse(point?.timestamp || '')))?.timestamp || '');
  const elapsed = (last - first) / 1_000;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null;
}

function distanceBetween(left, right) {
  const earthRadiusMeters = 6_371_008.8;
  const lat1 = left.latitude * Math.PI / 180;
  const lat2 = right.latitude * Math.PI / 180;
  const deltaLat = lat2 - lat1;
  const deltaLon = (right.longitude - left.longitude) * Math.PI / 180;
  const arc = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, arc)));
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function analyzeRoute(points, { heartRate = [], splitDistanceMeters = 1_000 } = {}) {
  const accepted = [];
  let distanceMeters = 0;
  let rejectedPointCount = 0;
  let timeGapCount = 0;
  for (const point of Array.isArray(points) ? points : []) {
    if (!isCoordinate(point)) { rejectedPointCount++; continue; }
    const timestamp = Number.isFinite(Date.parse(point.timestamp || '')) ? Date.parse(point.timestamp) : null;
    const altitudeMeters = Number.isFinite(point.altitudeMeters) ? point.altitudeMeters : null;
    const previous = accepted.at(-1);
    let timeGap = false;
    if (previous) {
      const segmentDistance = distanceBetween(previous, point);
      const elapsedSeconds = timestamp !== null && previous.timestamp !== null ? (timestamp - previous.timestamp) / 1_000 : null;
      if (elapsedSeconds !== null && (elapsedSeconds <= 0 || segmentDistance / elapsedSeconds > 55)) {
        rejectedPointCount++;
        continue;
      }
      timeGap = elapsedSeconds !== null && elapsedSeconds > 600;
      if (timeGap) timeGapCount++;
      distanceMeters += segmentDistance;
    }
    const speedKilometersPerHour = previous && !timeGap && timestamp !== null && previous.timestamp !== null
      ? distanceBetween(previous, point) / ((timestamp - previous.timestamp) / 1_000) * 3.6
      : null;
    accepted.push({ latitude:point.latitude, longitude:point.longitude, timestamp, altitudeMeters, cumulativeDistanceMeters:distanceMeters, speedKilometersPerHour, timeGap });
  }

  const altitudes = accepted.map((point, index) => median(accepted.slice(Math.max(0, index - 1), index + 2).map((item) => item.altitudeMeters)));
  const observedAltitudes = altitudes.filter(Number.isFinite);
  let elevationGainMeters = 0, elevationLossMeters = 0, previousAltitude = null;
  for (const altitude of altitudes) {
    if (altitude === null) continue;
    if (previousAltitude !== null) {
      const change = altitude - previousAltitude;
      if (change >= 3) elevationGainMeters += change;
      else if (change <= -3) elevationLossMeters -= change;
    }
    previousAltitude = altitude;
  }
  const timestampAtDistance = (target) => {
    for (let index = 1; index < accepted.length; index++) {
      const right = accepted[index], left = accepted[index - 1];
      if (target > right.cumulativeDistanceMeters || target < left.cumulativeDistanceMeters) continue;
      if (left.timestamp === null || right.timestamp === null) return null;
      const segment = right.cumulativeDistanceMeters - left.cumulativeDistanceMeters;
      return segment > 0 ? left.timestamp + (right.timestamp - left.timestamp) * (target - left.cumulativeDistanceMeters) / segment : null;
    }
    return null;
  };
  const samples = (Array.isArray(heartRate) ? heartRate : []).flatMap((sample) => {
    const timestamp = Date.parse(sample?.timestamp || ''), bpm = Number(sample?.beatsPerMinute);
    return Number.isFinite(timestamp) && Number.isFinite(bpm) && bpm > 0 ? [{ timestamp, bpm }] : [];
  });
  const splits = [];
  if (Number.isFinite(splitDistanceMeters) && splitDistanceMeters >= 100 && accepted.length > 1) {
    const boundaries = [0];
    for (let target = splitDistanceMeters; target < distanceMeters; target += splitDistanceMeters) boundaries.push(target);
    if (distanceMeters - boundaries.at(-1) >= 100) boundaries.push(distanceMeters);
    else if (boundaries.length === 1 && distanceMeters >= 100) boundaries.push(distanceMeters);
    for (let index = 1; index < boundaries.length; index++) {
      const startDistance = boundaries[index - 1], endDistance = boundaries[index];
      const startTime = timestampAtDistance(startDistance), endTime = timestampAtDistance(endDistance);
      const crossesTimeGap = accepted.slice(1).some((point, pointIndex) => point.timeGap
        && accepted[pointIndex].cumulativeDistanceMeters <= endDistance
        && point.cumulativeDistanceMeters >= startDistance);
      const elapsedSeconds = !crossesTimeGap && startTime !== null && endTime !== null && endTime > startTime ? (endTime - startTime) / 1_000 : null;
      const rates = elapsedSeconds === null ? [] : samples.filter((sample) => sample.timestamp >= startTime && sample.timestamp < endTime).map((sample) => sample.bpm);
      const splitDistance = endDistance - startDistance;
      splits.push({
        index,
        distanceMeters: splitDistance,
        elapsedSeconds,
        averagePaceSecondsPerKilometer: elapsedSeconds ? elapsedSeconds / (splitDistance / 1_000) : null,
        averageSpeedKilometersPerHour: elapsedSeconds ? splitDistance / elapsedSeconds * 3.6 : null,
        averageHeartRate: rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null,
        isPartial: splitDistance < splitDistanceMeters - 1
      });
    }
  }
  const timestamps = accepted.map((point) => point.timestamp).filter(Number.isFinite);
  const routeElapsed = timestamps.length > 1 ? (timestamps.at(-1) - timestamps[0]) / 1_000 : null;
  return {
    distanceMeters,
    elapsedSeconds: Number.isFinite(routeElapsed) && routeElapsed > 0 ? routeElapsed : null,
    elevationGainMeters: observedAltitudes.length > 1 ? elevationGainMeters : null,
    elevationLossMeters: observedAltitudes.length > 1 ? elevationLossMeters : null,
    minimumAltitudeMeters: observedAltitudes.length ? observedAltitudes.reduce((min, value) => Math.min(min, value), Infinity) : null,
    maximumAltitudeMeters: observedAltitudes.length ? observedAltitudes.reduce((max, value) => Math.max(max, value), -Infinity) : null,
    validPointCount: accepted.length,
    rejectedPointCount,
    timeGapCount,
    track: accepted,
    splits
  };
}

export function projectRoute(points, width = 600, height = 260, padding = 28) {
  const valid = (Array.isArray(points) ? points : []).filter(isCoordinate);
  if (valid.length < 2 || width <= padding * 2 || height <= padding * 2) return null;

  const meanLatitude = valid.reduce((sum, point) => sum + point.latitude, 0) / valid.length;
  const longitudeScale = Math.max(0.000001, Math.cos(meanLatitude * Math.PI / 180));
  const projected = valid.map((point) => ({
    x: point.longitude * longitudeScale,
    y: point.latitude
  }));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  if (maxX - minX < 1e-12 && maxY - minY < 1e-12) return null;

  const spanX = Math.max(maxX - minX, 1e-12);
  const spanY = Math.max(maxY - minY, 1e-12);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const usedWidth = spanX * scale;
  const usedHeight = spanY * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;

  return projected.map((point) => ({
    x: Math.max(padding, Math.min(width - padding, offsetX + (point.x - minX) * scale)),
    y: Math.max(padding, Math.min(height - padding, offsetY + usedHeight - (point.y - minY) * scale))
  }));
}

export function buildRouteMapSVG(points) {
  const width = 600;
  const height = 260;
  const route = projectRoute(points, width, height);
  if (!route) return null;
  const line = route.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const [start] = route;
  const end = route.at(-1);

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="GPS 경로 미리보기" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="route-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--route-grid, #d8e1df)" stroke-width="1"/></pattern></defs>
    <rect width="${width}" height="${height}" fill="var(--route-map-bg, #f2f5f4)"/>
    <rect width="${width}" height="${height}" fill="url(#route-grid)"/>
    <polyline points="${line}" fill="none" stroke="var(--route-line, #21756e)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${start.x.toFixed(2)}" cy="${start.y.toFixed(2)}" r="9" fill="var(--route-start, #25a76f)" stroke="white" stroke-width="4"/>
    <circle cx="${end.x.toFixed(2)}" cy="${end.y.toFixed(2)}" r="9" fill="var(--route-end, #e66e5d)" stroke="white" stroke-width="4"/>
  </svg>`;
}
